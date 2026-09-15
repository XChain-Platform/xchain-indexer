/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const sinon = require('sinon');

const HubDbSync = require('../../../../../../src/hub/hub_db_sync.js');
const FROZEN    = HubDbSync.HUB_SYNC_WATERMARK_GRACE_S;

const GRACE_ENV = 'HUB_SYNC_ATTEST_RESPONSE_GRACE_S';

// The mirror table's columns, as SHOW COLUMNS serves them (src/sql/attestation_responses.sql).
// Only the subset the tests exercise carries a Type; the rest are irrelevant to the filter.
const RESPONSE_COLUMNS = ['id', 'network', 'request_id', 'request_action_index', 'request_block_index',
                          'provider_id', 'status', 'response_payload', 'response_hash', 'meta',
                          'effective_time', 'signer_pubkeys', 'signatures', 'widen',
                          'batch_action_index', 'finalized_at'];

// state_checkpoints is the id-PARITY member of the same HUB_STATE_TABLES class: it is the
// control for both the id strip and the cursor, so a test that passes for the wrong reason
// (the strip applying to everything, or every table re-paging) shows up as a control failure.
const CHECKPOINT_COLUMNS = ['id', 'network', 'chain', 'block_index', 'state_hash', 'checkpoint_seq'];

function showColumns(names) {
    return names.map(n => ({ Field: n, Type: 'varchar(64)' }));
}

// A HubDbSync whose hubDb answers the two reads the mirror paths issue (SHOW COLUMNS and
// the MAX(id) cursor) and records every other query, which is what the assertions read.
function makeSync(opts) {
    opts = opts || {};
    const queries = [];
    const columns = opts.columns || { attestation_responses: RESPONSE_COLUMNS, state_checkpoints: CHECKPOINT_COLUMNS };
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        queries.push({ sql, args });
        let show = /^SHOW COLUMNS FROM (\S+)/.exec(sql);
        if (show) return showColumns(columns[show[1]] || []);
        if (/^SELECT MAX\(id\)/.test(sql)) return [{ max_id: opts.localMaxId != null ? opts.localMaxId : 0 }];
        return [];
    });
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: opts.network || 'regtest' });
    return { sync, queries, doQuery };
}

// The INSERT the mirror issued for `table`, ignoring the schema and cursor reads around it.
function insertFor(queries, table) {
    return queries.filter(q => /^INSERT/.test(q.sql) && q.sql.indexOf(table) !== -1);
}

function responseRow() {
    return {
        id: 4711,                                    // the FOLLOWED hub's local id, not ours
        network: 'regtest',
        request_id: 'a'.repeat(64),
        request_action_index: 90210,
        request_block_index: 812345,
        provider_id: 'http_get',
        status: 'ok',
        response_payload: '{"ok":true}',
        response_hash: 'b'.repeat(64),
        meta: '',
        effective_time: 1767225600,
        signer_pubkeys: '["' + 'c'.repeat(64) + '"]',
        signatures: '[{"pubkey":"' + 'c'.repeat(64) + '","sig":"' + 'd'.repeat(128) + '"}]',
        widen: 0,
        batch_action_index: null,                    // filled once the v5/v6 batch carrying the body lands
        finalized_at: 1767225480
    };
}

// ── a MariaDB stand-in that OBEYS the generated statement ────────────────────
//
// The behaviour cases below (a signed column cannot be rewritten, a link can be
// filled once) are properties of the SQL this module emits, so the store executes
// that SQL rather than re-stating the rule: it reads the column list and the ON
// DUPLICATE KEY UPDATE clause out of the statement itself and applies them. Widen
// the ODKU clause and these cases change behaviour, which is what makes them
// falsifiable rather than decorative.
// Split an ON DUPLICATE KEY UPDATE body on its top-level commas only, so a comma
// inside COALESCE(...) does not look like the start of a second assignment.
function splitAssignments(body) {
    let out = [], depth = 0, start = 0;
    for (let i = 0; i < body.length; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')') depth--;
        else if (body[i] === ',' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
    }
    out.push(body.slice(start));
    return out.map(s => s.trim()).filter(s => s.length > 0);
}

function applyStatement(store, sql, args) {
    let cols = /\(([^)]*)\) VALUES/.exec(sql)[1].split(',').map(s => s.trim().replace(/`/g, ''));
    let incoming = {};
    cols.forEach((c, i) => { incoming[c] = args[i]; });
    let key      = String(incoming.network) + '|' + String(incoming.request_id);
    let existing = store.get(key);
    if (!existing) { store.set(key, Object.assign({}, incoming)); return; }

    let odku = /ON DUPLICATE KEY UPDATE (.+)$/.exec(sql);
    if (!odku) return;                                   // INSERT IGNORE: the duplicate is a no-op
    for (let assignment of splitAssignments(odku[1])) {
        let cut    = assignment.indexOf('=');
        let target = assignment.slice(0, cut).trim().replace(/`/g, '');
        let expr   = assignment.slice(cut + 1).trim();
        let coalesce = /^COALESCE\(\s*`?(\w+)`?\s*,\s*VALUES\(\s*`?(\w+)`?\s*\)\s*\)$/.exec(expr);
        let plain    = /^VALUES\(\s*`?(\w+)`?\s*\)$/.exec(expr);
        if (coalesce)   existing[target] = (existing[coalesce[1]] == null) ? incoming[coalesce[2]] : existing[coalesce[1]];
        else if (plain) existing[target] = incoming[plain[1]];
        else throw new Error('the test store cannot execute the assignment `' + assignment.trim() +
                             '`; teach it that form before relying on this case');
    }
}

// A HubDbSync whose hub DB is the store above and whose Database back-reference
// exposes the local indexer connection, which is how the module reaches the
// request-id-keyed setter that carries the link onto the applied ATTEST v1 row.
function makeStoredSync() {
    const store  = new Map();
    const setter = sinon.stub().resolves();
    const hubDb  = {
        indexer: { indexerDb: { setAttestationResponseBatchIndex: setter } },
        doQuery: async (sql, args) => {
            let show = /^SHOW COLUMNS FROM (\S+)/.exec(sql);
            if (show) return showColumns(show[1] === 'attestation_responses' ? RESPONSE_COLUMNS : []);
            if (/^SELECT batch_action_index FROM attestation_responses/.test(sql)) {
                let row = store.get(String(args[0]) + '|' + String(args[1]));
                return row ? [{ batch_action_index: row.batch_action_index }] : [];
            }
            if (/^INSERT/.test(sql)) { applyStatement(store, sql, args); return {}; }
            return [];
        }
    };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', network: 'regtest' });
    const stored = () => store.get('regtest|' + 'a'.repeat(64));
    return { sync, store, stored, setter };
}

module.exports = {
    HubDbSync, FROZEN, GRACE_ENV, RESPONSE_COLUMNS, CHECKPOINT_COLUMNS,
    makeSync, insertFor, responseRow, splitAssignments, makeStoredSync,
};

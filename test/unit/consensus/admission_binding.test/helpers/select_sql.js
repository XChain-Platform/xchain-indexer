/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The SQL pins of the admission-binding mirrored-selects part: the pre-train statements
 * verbatim, the guarded height form, the never-bare check, and the capturing stub
 * databases that run the shipped db and bridge_settlements readers.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const bridgeSettlementsMixin = require('../../../../../src/db/bridge_settlements/index.js');
const { NETWORK } = require('./arms.js');

// The settle pass reaches the mirror through the db/bridge_settlements methods, so a
// capturing stub has to carry the REAL ones bound over its own doQuery. That is what makes
// the literal-string assertions below a check on the shipped statements rather than on
// statements this file wrote.
function bindSettlementReads(db){
    for(const m of Reflect.ownKeys(bridgeSettlementsMixin))
        db[m] = bridgeSettlementsMixin[m].bind(db);
    return db;
}

// ---------------------------------------------------------------------------
// The mirrored selects: SQL text pinned literally in both arms.
// ---------------------------------------------------------------------------

// The pre-train statements, verbatim from db.js and bridge_settle.js at the SHA this row
// was built on. A change to any of these below the activation is a consensus change.
const LEGACY_SQL = {
    matches: `SELECT * FROM cross_chain_matches
             WHERE status = 'finalized' AND network = ? AND effective_time <= ? AND (a_chain = ? OR b_chain = ?)
             ORDER BY snapshot_block ASC, match_id ASC`,
    dispatches: `SELECT * FROM cross_chain_calls
             WHERE phase = 'dispatch' AND status = 'finalized' AND network = ?
               AND target_chain = ? AND effective_time <= ?
             ORDER BY snapshot_block ASC, call_id ASC`,
    resultsSingleDb: `SELECT c.* FROM cross_chain_calls c
                 WHERE c.phase = 'result' AND c.status = 'finalized' AND c.network = ?
                   AND c.source_chain = ? AND c.effective_time <= ?
                   AND NOT EXISTS (
                       SELECT 1 FROM cross_chain_call_callbacks k WHERE k.call_id = c.call_id)
                 ORDER BY c.snapshot_block ASC, c.call_id ASC
                 LIMIT ?`,
    resultsRemote: `SELECT * FROM cross_chain_calls
             WHERE phase = 'result' AND status = 'finalized' AND network = ?
               AND source_chain = ? AND effective_time <= ?
             ORDER BY snapshot_block ASC, call_id ASC`,
    attest: `SELECT request_id, provider_id, status, response_payload, response_hash, meta,
                        effective_time, signer_pubkeys, signatures, widen, batch_action_index
                 FROM attestation_responses
                 WHERE network = ? AND effective_time <= ? AND request_id IN (?,?)`,
    transfers: `SELECT * FROM bridge_transfers
         WHERE status = 'finalized' AND network = ? AND effective_time <= ? AND dest_chain = ?
         ORDER BY snapshot_block ASC, transfer_id ASC`,
    policies: `SELECT * FROM policy_snapshots
         WHERE status = 'finalized' AND network = ? AND effective_time <= ?`
};

// The guarded height form (c33) for a column, with the outer parentheses the selects compose it under.
const c33 = (col, p) => '((' + (p || '') + col + ' IS NULL AND ' + (p || '') + 'effective_time <= ?) OR (' +
                        (p || '') + col + ' IS NOT NULL AND ' + (p || '') + col + ' <= ?))';

// A never-bare check: the only `<col> <= ?` in the statement is the one inside the IS NOT
// NULL arm, so a bare comparison on the nullable column cannot slip in beside it.
function assertNeverBare(sql, col) {
    const bare = sql.split(col + ' <= ?').length - 1;
    const guarded = sql.split(col + ' IS NOT NULL AND ' + col + ' <= ?').length - 1;
    assert.strictEqual(bare, 1, 'exactly one height comparison: ' + sql);
    assert.strictEqual(guarded, 1, 'and it is inside the IS NOT NULL arm: ' + sql);
    assert.ok(sql.indexOf(col + ' IS NULL AND ') !== -1, 'the IS NULL legacy arm must be present: ' + sql);
}

function stubDb(h, coin, opts) {
    const o = opts || {};
    const indexer = { config: { COIN: coin, NETWORK: NETWORK }, util: null };
    const db = new h.Database('127.0.0.1', 3306, 'xchain_test', 'u', 'p', indexer);
    const captured = [];
    // The consensus readers go through doQueryStrict, which reaches the pool directly rather
    // than through doQuery, so both entry points capture.
    db.doQuery = async (sql, args) => { captured.push({ sql, args }); return []; };
    db.doQueryStrict = db.doQuery;
    if (o.remoteMirror) {
        const remoteQuery = async (sql, args) => { captured.push({ sql, args, remote: true }); return []; };
        indexer.hubDb = { doQuery: remoteQuery, doQueryStrict: remoteQuery };
    }
    return { db, captured };
}

module.exports = { bindSettlementReads, LEGACY_SQL, c33, assertNeverBare, stubDb };

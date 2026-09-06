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
 **********************************************************************
 * The response mirror must accept every body the on-chain ATTEST path accepts.
 *
 * attestation_responses carries a finalized ATTEST response in place of a validator-paid
 * on-chain ATTEST v1 transaction. That substitution only holds while the two storage paths
 * have the SAME value domain: a response the v1 row could hold but the mirror row cannot is
 * a response no node can reach, for a request that then waits out its expiry.
 *
 * The failure is a charset one. attests.response_payload and attests.meta are utf8mb4; a
 * mirror column that declares no charset of its own inherits the table's utf8mb3 tail and
 * holds three bytes per character. The hub writes the body decoded as UTF-8 and
 * response_hash over the BYTES the responsible set signed, so a 4-byte character either
 * fails the INSERT (errno 1366 under STRICT_TRANS_TABLES) or is truncated into a body that
 * no longer hashes to response_hash. attestation_responses re-pages from cursor 0
 * (hub_db_sync FULL_REPAGE_TABLES), so the same row is re-delivered and re-refused on every
 * drain rather than being skipped once.
 *
 * Three arms, one per path the value has to survive:
 *   TWIN       - each mirrored provider-byte column declares the charset its on-chain twin
 *                in src/sql/attests.sql declares (what a fresh install gets).
 *   LEDGER     - a dated mode=auto migration MODIFYs each to that charset, so a long-lived
 *                database converges unattended (alterTableForDrift adds a missing column
 *                and never retypes an existing one).
 *   INGEST     - the real _applyRow, driven through a connection stub that enforces the
 *                server's utf8mb3 rejection against the DECLARED charset of each column it
 *                is handed. The stub reads src/sql/attestation_responses.sql, so reverting
 *                the schema edit turns this arm red rather than leaving the guard passing
 *                on a schema-only assertion.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const Database  = require('../../src/db');
const HubDbSync = require('../../src/hub_db_sync.js');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');

// U+1F680: four UTF-8 bytes, so utf8mb3 cannot hold it at any column width.
const EMOJI = '\u{1F680}';

// The mirror columns that carry PROVIDER bytes, each with the src/sql/attests.sql column it
// stands in for. provider_id is deliberately absent: a mirror row exists only for a round
// that reached quorum, which requires a governance-registered provider, so no wire-chosen
// identifier reaches it - and it is NOT NULL, which a mode=auto MODIFY may not restate.
const PROVIDER_BYTE_COLUMNS = [
    { column: 'response_payload', twin: 'response_payload' },
    { column: 'meta',             twin: 'meta' },
];

const stripComments   = Database.prototype.stripSqlLineComments.bind({});
const declaredCharset = (spec) => {
    const m = /CHARACTER\s+SET\s+(\w+)/i.exec(String(spec || ''));
    return m ? m[1].toLowerCase() : null;
};
const hasAstralChar = (v) => typeof v === 'string' && /[\u{10000}-\u{10FFFF}]/u.test(v);

// name -> full comment-stripped column definition line, from the real definition file.
function definitionColumns(table) {
    const raw    = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    const parsed = Database.prototype.parseExpectedColumns.call(
        { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
    assert.ok(parsed, 'could not parse src/sql/' + table + '.sql');
    const out = {};
    for (const c of parsed) out[c.name] = c.definition;
    return out;
}

// Bind an INSERT's parameters to the columns they land in: { table, bound: [[col, value]] }.
// Null for anything that is not an INSERT (the SHOW COLUMNS probe, the stored-link refetch).
// The ON DUPLICATE KEY UPDATE tail assigns no placeholder, so matching the VALUES tuple is
// enough here; a literal in that tuple would still consume no argument.
function insertBindings(sql, args) {
    const head = /^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+`?(\w+)`?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(String(sql));
    if (!head) return null;
    const columns = head[2].split(',').map(s => s.trim().replace(/`/g, ''));
    const slots   = head[3].split(',').map(s => s.trim());
    const bound   = [];
    let next = 0;
    slots.forEach(function (slot, i) {
        if (slot !== '?') return;
        const value = (args || [])[next++];
        if (columns[i]) bound.push([columns[i], value]);
    });
    return { table: head[1], bound };
}

// SHOW COLUMNS as the driver serves it, with each column's real declared type, so
// coerceMirrorValue sees the same types the live mirror table reports.
function showColumns(defs) {
    return Object.keys(defs).map(name => ({
        Field: name,
        Type:  String(defs[name]).replace(new RegExp('^\\s*`?' + name + '`?\\s*', 'i'), '')
                                 .split(/\s+/)[0].toLowerCase(),
    }));
}

/**
 * A doQuery stub that behaves like a STRICT_TRANS_TABLES server for the mirror table: it
 * answers the SHOW COLUMNS probe from src/sql/attestation_responses.sql, then maps each
 * INSERT's parameters onto the named columns and rejects a 4-byte character bound to a
 * column that definition does NOT declare utf8mb4, the way MariaDB does.
 */
function makeStrictServer() {
    const defs = definitionColumns('attestation_responses');
    return sinon.stub().callsFake(async function (sql, args) {
        if (/^SHOW COLUMNS FROM/i.test(String(sql))) return showColumns(defs);
        const insert = insertBindings(sql, args);
        if (!insert) return [];
        for (const [column, value] of insert.bound) {
            if (!hasAstralChar(value)) continue;
            assert.ok(Object.prototype.hasOwnProperty.call(defs, column),
                'stub cannot check attestation_responses.' + column + ': not declared in the definition');
            if (declaredCharset(defs[column]) !== 'utf8mb4')
                throw Object.assign(
                    new Error("Incorrect string value for column '" + column + "' at row 1"),
                    { errno: 1366, code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' });
        }
        return [];
    });
}

// One finalized response as the hub broadcasts it. `body` and `meta` are the caller's, so a
// case can put a 4-byte character where the provider would have put one.
function responseRow(body, meta) {
    return {
        id: 4711,                                    // the FOLLOWED hub's local id, stripped on apply
        network: 'regtest',
        request_id: 'a'.repeat(64),
        request_action_index: 90210,
        request_block_index: 812345,
        provider_id: 'http_get',
        status: 'ok',
        response_payload: body,
        response_hash: 'b'.repeat(64),
        meta: meta,
        effective_time: 1767225600,
        signer_pubkeys: '["' + 'c'.repeat(64) + '"]',
        signatures: '[{"pubkey":"' + 'c'.repeat(64) + '","sig":"' + 'd'.repeat(128) + '"}]',
        widen: 0,
        batch_action_index: null,
        finalized_at: 1767225480,
    };
}

// Every table.column a dated migration MODIFYs, with the file and its apply mode.
function migrationModifies() {
    const out = new Map();
    for (const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
        const raw  = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
        const mode = Database.prototype._migrationMode.call({}, raw);
        for (const stmt of stripComments(raw).split(';')) {
            const t = /ALTER\s+TABLE\s+`?(\w+)`?/i.exec(stmt);
            if (!t) continue;
            for (const m of stmt.matchAll(/\bMODIFY\s+(?:COLUMN\s+)?`?(\w+)`?([\s\S]*?)(?=,\s*MODIFY\s|,\s*ADD\s|,\s*DROP\s|$)/gi))
                out.set(t[1] + '.' + m[1], { file, mode, spec: m[2] });
        }
    }
    return out;
}

describe('the ATTEST response mirror holds every body the on-chain path holds @regression', function () {

    afterEach(() => sinon.restore());

    it('sanity: the fixture character really is 4 bytes and the twin columns are utf8mb4', function () {
        assert.strictEqual(Buffer.byteLength(EMOJI, 'utf8'), 4);
        assert.ok(hasAstralChar(EMOJI));
        assert.ok(!hasAstralChar('plain ascii value'));
        // The whole comparison rests on the on-chain side being the wider one. If attests
        // ever narrows, this guard would "pass" by holding the mirror to utf8mb3.
        const attests = definitionColumns('attests');
        for (const entry of PROVIDER_BYTE_COLUMNS)
            assert.strictEqual(declaredCharset(attests[entry.twin]), 'utf8mb4',
                'attests.' + entry.twin + ' is no longer utf8mb4, so this file compares against the wrong twin');
    });

    // TWIN: what a fresh install gets from createTable.
    it('every provider-byte mirror column declares its on-chain twin\'s charset', function () {
        const mirror  = definitionColumns('attestation_responses');
        const attests = definitionColumns('attests');
        const narrow  = [];
        for (const entry of PROVIDER_BYTE_COLUMNS) {
            const want = declaredCharset(attests[entry.twin]);
            const got  = declaredCharset(mirror[entry.column]);
            if (got !== want)
                narrow.push('  attestation_responses.' + entry.column + ': ' + (got || 'the table tail (utf8mb3)') +
                            ', but attests.' + entry.twin + ' is ' + want);
        }
        assert.deepStrictEqual(narrow, [],
            'These mirror columns hold a NARROWER value domain than the on-chain column they stand in for, so a ' +
            'response body the ATTEST v1 path accepts cannot be carried by the mirror that replaced it. The row ' +
            'is re-delivered and re-refused on every drain (attestation_responses re-pages from cursor 0), and ' +
            'the request it answers expires unresolved:\n' + narrow.join('\n'));
    });

    // LEDGER: what a long-lived database converges to, and whether it needs an operator.
    it('a dated mode=auto migration widens every provider-byte column', function () {
        const mirror  = definitionColumns('attestation_responses');
        const modifies = migrationModifies();
        const missing  = [];
        const misfiled = [];
        for (const entry of PROVIDER_BYTE_COLUMNS) {
            const found = modifies.get('attestation_responses.' + entry.column);
            if (!found) { missing.push('  attestation_responses.' + entry.column); continue; }
            if (declaredCharset(found.spec) !== declaredCharset(mirror[entry.column]))
                misfiled.push('  attestation_responses.' + entry.column + ': ' + found.file + ' widens it to ' +
                              declaredCharset(found.spec) + ', the definition declares ' + declaredCharset(mirror[entry.column]));
            if (found.mode !== 'auto')
                misfiled.push('  attestation_responses.' + entry.column + ': ' + found.file + ' is mode=' + found.mode +
                              ', so the mirror stays wedged until an operator runs it by hand');
        }
        assert.deepStrictEqual(missing, [],
            'These columns are utf8mb4 in the definition but no dated migration widens them, so a long-lived ' +
            'database keeps utf8mb3 forever: the boot-time drift reconciler adds a missing column and never ' +
            'retypes an existing one:\n' + missing.join('\n'));
        assert.deepStrictEqual(misfiled, [], 'Migration / definition disagreement:\n' + misfiled.join('\n'));
    });

    // INGEST: the real applier, against the strict-server stub.
    describe('_applyRow survives a 4-byte character', function () {

        it('applies a response whose body and meta carry a 4-byte character', async function () {
            const doQuery = makeStrictServer();
            const sync    = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'regtest' });
            await sync._applyRow('attestation_responses', responseRow('{"emoji":"' + EMOJI + '"}', 'model=' + EMOJI));

            const insert = doQuery.getCalls()
                .map(c => insertBindings(c.args[0], c.args[1]))
                .find(i => i && i.table === 'attestation_responses');
            assert.ok(insert, 'the applier issued no INSERT into attestation_responses');
            const carried = new Set(insert.bound.filter(([, v]) => hasAstralChar(v)).map(([c]) => c));
            assert.deepStrictEqual([...carried].sort(), ['meta', 'response_payload'],
                'the 4-byte character never reached the columns under test, so this arm proves nothing');
        });

        it('control: the same stub REJECTS a 4-byte character bound to a utf8mb3 mirror column', async function () {
            const doQuery = makeStrictServer();
            const sync    = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'regtest' });
            // signer_pubkeys is hex the hub composes itself, so it legitimately stays on the
            // table tail. Feeding it an astral character is the falsification: if this
            // resolves, the stub is accepting everything and the arm above is vacuous.
            const row = responseRow('{"ok":true}', '');
            row.signer_pubkeys = '["' + EMOJI + '"]';
            await assert.rejects(() => sync._applyRow('attestation_responses', row),
                (err) => err.errno === 1366);
        });
    });
});

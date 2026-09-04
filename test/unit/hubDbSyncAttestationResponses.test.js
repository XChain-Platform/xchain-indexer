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
 * test/unit/hubDbSyncAttestationResponses.test.js
 *
 * attestation_responses mirror registration (the ATTEST response-mirror
 * design, §2.2, §4.2, decisions D24/D55).
 *
 * The finalized ATTEST response reaches every indexer through hub_db_sync
 * instead of through a validator-paid on-chain transaction, which puts three
 * registrations on the consensus path and one seam under the barrier row:
 *
 *   1. HUB_STATE_TABLES membership, which is also what puts the table in the
 *      bootstrap drain loop (the loop concatenates the class arrays).
 *   2. The natural-key id strip in _applyRow. Every hub that holds the
 *      finalized artifact writes its OWN row and gossips it, so two hubs carry
 *      different ids for one logical row; identity is UNIQUE (network,
 *      request_id) and a wire id kept here can land on a locally-assigned PK
 *      where INSERT IGNORE drops a real response with no error.
 *   3. FULL_REPAGE_TABLES membership, which FOLLOWS FROM (2) rather than from
 *      any in-place upgrade (D55): once the ids are locally assigned, a
 *      since_id = MAX(local id) cursor is not a position in the followed hub's
 *      id space at all.
 *   4. The frozen watermark grace and its regtest-only env seam.
 *   5. The one-column batch-link upsert. Every signed column is fixed at first
 *      insert, and only batch_action_index (the display link to the on-chain
 *      v5/v6 batch, D78) can be filled later, from NULL, once.
 *
 * These are driven against the real methods, not asserted against the
 * declarations: every test below reads the SQL the mirror would actually issue
 * or the cursor it would actually ask the hub for. Each is falsifiable by
 * removing the table from the list it pins (both falsifications were run).
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');
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

describe('HubDbSync attestation_responses mirror registration @regression @tier1', function () {

    afterEach(function () {
        delete process.env[GRACE_ENV];
        sinon.restore();
    });

    // ── class membership, proved through the drain loop rather than the array ──

    it('_bootstrapAll drains attestation_responses, which is what HUB_STATE_TABLES membership buys', async function () {
        const { sync } = makeSync();
        const drained = [];
        sinon.stub(sync, '_bootstrapTable').callsFake(async (table) => { drained.push(table); return 1; });
        sinon.stub(sync, '_advanceWatermark');
        await sync._bootstrapAll();
        assert.ok(drained.indexOf('attestation_responses') !== -1,
            'the bootstrap loop must page attestation_responses; it concatenates the class arrays, so ' +
            'membership in HUB_STATE_TABLES is the whole mechanism');
    });

    // ── the natural-key id strip ──

    it('_applyRow strips the hub id from an attestation_responses row', async function () {
        const { sync, queries } = makeSync();
        const row = responseRow();
        await sync._applyRow('attestation_responses', row);

        const inserts = insertFor(queries, 'attestation_responses');
        assert.strictEqual(inserts.length, 1, 'exactly one INSERT for the row');
        const sql = inserts[0].sql;

        // The column list, read out of the generated SQL rather than assumed.
        const cols = /\(([^)]*)\) VALUES/.exec(sql)[1].split(',').map(s => s.trim().replace(/`/g, ''));
        assert.ok(cols.indexOf('id') === -1,
            'the hub id must not be written: hub ids are hub-LOCAL (every hub that verifies the ' +
            'gossiped result inserts its own row), so a wire id can collide with a locally-assigned ' +
            'PK and INSERT IGNORE would silently drop a real response. Generated SQL was: ' + sql);
        assert.ok(cols.indexOf('network') !== -1 && cols.indexOf('request_id') !== -1,
            'the natural key (network, request_id) must be written, or the row has no identity');
        assert.strictEqual(inserts[0].args.length, cols.length, 'one bound arg per written column');
        assert.ok(inserts[0].args.indexOf(row.id) === -1, 'the hub id must not be bound as a value either');
    });

    it('_applyRow falls back to a plain INSERT IGNORE for a row that carries no link column', async function () {
        const { sync, queries } = makeSync();
        const row = responseRow();
        delete row.batch_action_index;                   // a hub that does not serve the column yet
        await sync._applyRow('attestation_responses', row);
        assert.ok(/^INSERT IGNORE INTO attestation_responses /.test(insertFor(queries, 'attestation_responses')[0].sql),
            'with no link on the wire there is nothing to upsert, and the plain insert keeps a hub that ' +
            'predates the column working unchanged');
    });

    it('_applyRow KEEPS the id for state_checkpoints, the id-parity control in the same class', async function () {
        const { sync, queries } = makeSync();
        await sync._applyRow('state_checkpoints', { id: 77, network: 'regtest', chain: 'BTC',
                                                   block_index: 5, state_hash: 'e'.repeat(64), checkpoint_seq: 3 });
        const cols = /\(([^)]*)\) VALUES/.exec(insertFor(queries, 'state_checkpoints')[0].sql)[1]
            .split(',').map(s => s.trim());
        assert.ok(cols.indexOf('id') !== -1,
            'state_checkpoints is an id-parity mirror; if the strip reaches it, the strip condition is ' +
            'too broad and this suite would pass for the wrong reason');
    });

    // ── the one-column batch-link upsert (D78) ──

    it('generates an upsert whose ONLY assignment is a first-stamp-wins batch_action_index', async function () {
        const { sync, queries } = makeSync();
        await sync._applyRow('attestation_responses', responseRow());
        const sql = insertFor(queries, 'attestation_responses')[0].sql;

        assert.ok(/^INSERT INTO attestation_responses /.test(sql),
            'a plain INSERT IGNORE would drop the batch stamp the hub sends as a re-broadcast of an ' +
            'already-mirrored row, leaving the link NULL on every streamed mirror while a fresh ' +
            'bootstrap served it. Generated SQL was: ' + sql);
        const odku = /ON DUPLICATE KEY UPDATE (.+)$/.exec(sql);
        assert.ok(odku, 'the upgrade clause must be present. Generated SQL was: ' + sql);
        assert.deepStrictEqual(splitAssignments(odku[1]),
            ['batch_action_index = COALESCE(batch_action_index, VALUES(batch_action_index))'],
            'EXACTLY one assignment, and it fills from NULL only. Every other column is content a ' +
            'responsible set signed and this node has already verified; making one of them assignable ' +
            'would let a re-delivery rewrite a verified response under an unchanged natural key');
    });

    it('a re-delivered row cannot rewrite a signed column', async function () {
        const { sync, stored } = makeStoredSync();
        const first = responseRow();
        await sync._applyRow('attestation_responses', first);

        const forged = responseRow();
        forged.signatures       = '[{"pubkey":"' + 'e'.repeat(64) + '","sig":"' + 'f'.repeat(128) + '"}]';
        forged.response_payload = '{"ok":false}';
        forged.status           = 'expired';
        await sync._applyRow('attestation_responses', forged);

        assert.strictEqual(stored().signatures, first.signatures,
            'the stored signature set must survive a re-delivery: the row is transport, the applier ' +
            'has already verified this copy, and the natural key is the identity rather than the body');
        assert.strictEqual(stored().response_payload, first.response_payload, 'the attested body is fixed at insert');
        assert.strictEqual(stored().status, first.status, 'the terminal status is fixed at insert');
    });

    it('fills a NULL link from a re-delivery and stamps the applied v1 row through the request id', async function () {
        const { sync, stored, setter } = makeStoredSync();
        await sync._applyRow('attestation_responses', responseRow());
        assert.strictEqual(stored().batch_action_index, null, 'the row mirrors before its batch lands');
        assert.strictEqual(setter.callCount, 0, 'nothing to carry while the link is NULL');

        const linked = responseRow();
        linked.batch_action_index = 4242;
        await sync._applyRow('attestation_responses', linked);

        assert.strictEqual(stored().batch_action_index, 4242, 'the stamp must land on the mirrored row');
        assert.strictEqual(setter.callCount, 1,
            'the v1 row the applier minted locally also carries the link, and the request id is the only ' +
            'identifier the two sides share: the batch is parsed on DOGE and names its responses by ' +
            'request_id, while the v1 action index was assigned on BTC');
        assert.deepStrictEqual(setter.firstCall.args, ['a'.repeat(64), 4242]);
    });

    it('a SECOND batch claiming the same response moves neither copy', async function () {
        const { sync, stored, setter } = makeStoredSync();
        const first = responseRow();
        first.batch_action_index = 4242;
        await sync._applyRow('attestation_responses', first);

        const second = responseRow();
        second.batch_action_index = 9999;
        await sync._applyRow('attestation_responses', second);

        assert.strictEqual(stored().batch_action_index, 4242, 'first stamp wins, as COALESCE says');
        assert.strictEqual(setter.callCount, 2, 'the link is re-asserted, never recomputed');
        assert.deepStrictEqual(setter.secondCall.args, ['a'.repeat(64), 4242],
            'the setter must write the value now STORED in the mirror, not the one that just arrived, ' +
            'or the two copies of a display link disagree after a duplicate batch');
    });

    it('skips the link entirely when there is no local indexer connection to stamp', async function () {
        const { sync, queries } = makeSync();
        const linked = responseRow();
        linked.batch_action_index = 4242;
        await sync._applyRow('attestation_responses', linked);
        assert.strictEqual(queries.filter(q => /^SELECT batch_action_index/.test(q.sql)).length, 0,
            'the explorer vendors this same client against a pool with no indexer and no attests table; ' +
            'the mirrored row still applies there, only the local stamp is skipped');
    });

    it('every other HUB_STATE_TABLES member keeps its plain INSERT IGNORE', async function () {
        const siblings = HubDbSync.HUB_STATE_TABLES.filter(t => t !== 'attestation_responses');
        // A shrunk list would make the loop below iterate zero (or one) times and pass
        // vacuously, hiding the very regression this guard exists to catch.
        assert.ok(siblings.length >= 2,
            'HUB_STATE_TABLES must still list attestation_responses siblings to guard, or this loop ' +
            'silently covers nothing');
        for (const table of siblings) {
            const { sync, queries } = makeSync({ columns: { [table]: ['id', 'network', 'batch_action_index'] } });
            await sync._applyRow(table, { id: 5, network: 'regtest', batch_action_index: 7 });
            assert.ok(new RegExp('^INSERT IGNORE INTO ' + table + ' ').test(insertFor(queries, table)[0].sql),
                table + ' is append-only with no column mutated after insert; the upsert is scoped to the ' +
                'one table whose link the hub stamps later, and a table name is the only thing scoping it');
        }
    });

    // ── HUB_STATE_TABLES export (row 51) ──

    it('exports HUB_STATE_TABLES as a frozen copy a caller cannot use to corrupt the class', function () {
        assert.deepStrictEqual(HubDbSync.HUB_STATE_TABLES,
            ['state_checkpoints', 'anchor_reward_attestations', 'attestation_responses']);
        assert.ok(Object.isFrozen(HubDbSync.HUB_STATE_TABLES), 'the export must be read-only');
        assert.throws(() => { HubDbSync.HUB_STATE_TABLES.push('rogue_table'); },
            'a caller mutating the returned array must not be able to reach the module\'s own membership');
    });

    // ── mirrorStatus() snapshot (row 48) ──

    it('mirrorStatus reports an honest disabled shape when no hub is configured', function () {
        const sync = new HubDbSync(null, {});
        assert.deepStrictEqual(sync.mirrorStatus(),
            { configured: false, connected: false, bootstrapped: false, streamWatermark: null, tables: {} });
    });

    it('mirrorStatus reports disconnected while enabled and no socket has opened', function () {
        const { sync } = makeSync();
        const status = sync.mirrorStatus();
        assert.strictEqual(status.configured, true);
        assert.strictEqual(status.connected, false, 'this.ws is null before a socket connects');
        assert.strictEqual(status.bootstrapped, false);
    });

    it('mirrorStatus reports connected once a live socket is assigned', function () {
        const { sync } = makeSync();
        sync.ws = { readyState: 1 };
        assert.strictEqual(sync.mirrorStatus().connected, true);
    });

    it('mirrorStatus reflects the stream watermark advancing, HUB_STATE_TABLES included', async function () {
        const { sync } = makeSync();
        assert.strictEqual(sync.mirrorStatus().streamWatermark, 0);
        sync._advanceWatermark(1700000000);
        const status = sync.mirrorStatus();
        assert.strictEqual(status.streamWatermark, 1700000000);
        for (const table of HubDbSync.HUB_STATE_TABLES) {
            assert.strictEqual(status.tables[table], 1700000000,
                table + ' has no scalar of its own; it rides the global watermark (§4.2)');
        }
    });

    it('mirrorStatus reports each per-table scalar the class actually tracks, and null where none exists', function () {
        const { sync } = makeSync();
        sync.oracleSyncTimestamp   = 111;
        sync.matchSyncTimestamp    = 222;
        sync.callSyncTimestamp     = 333;
        sync.priceSyncMaxTimestamp = 444;
        const tables = sync.mirrorStatus().tables;
        assert.strictEqual(tables.oracle_prices, 111);
        assert.strictEqual(tables.cross_chain_matches, 222);
        assert.strictEqual(tables.cross_chain_calls, 333);
        assert.strictEqual(tables.price_snapshots, 444);
        assert.strictEqual(tables.capability_snapshots, null,
            'capability_snapshots satisfaction is a live per-block query, never a cached scalar');
    });

    // ── the cursor that follows from the strip (D55) ──

    it('bootstraps attestation_responses from since_id 0 even when the local table holds high ids', async function () {
        const { sync } = makeSync({ localMaxId: 987654 });
        const paths = [];
        sinon.stub(sync, '_httpGet').callsFake(async (path) => { paths.push(path); return { rows: [], watermark: 1 }; });

        await sync._bootstrapTable('attestation_responses');

        assert.strictEqual(paths.length, 1, 'one page fetched (an empty page is a short page)');
        assert.ok(/since_id=0&/.test(paths[0]),
            'the cursor must re-page from 0: the local ids are LOCALLY assigned (the strip above), so ' +
            'MAX(local id) is not a position in the followed hub id space and since_id=987654 would ask ' +
            'for rows past the end of that hub table and drain zero rows forever. Path was: ' + paths[0]);
    });

    it('bootstraps state_checkpoints from MAX(local id), the id-parity cursor control', async function () {
        const { sync } = makeSync({ localMaxId: 987654 });
        const paths = [];
        sinon.stub(sync, '_httpGet').callsFake(async (path) => { paths.push(path); return { rows: [], watermark: 1 }; });

        await sync._bootstrapTable('state_checkpoints');

        assert.ok(/since_id=987654&/.test(paths[0]),
            'state_checkpoints keeps hub-id parity and must page incrementally; if this also re-pages, ' +
            'the FULL_REPAGE assertion above proves nothing. Path was: ' + paths[0]);
    });

    it('purges foreign-network rows before reading the cursor, which needs the network column', async function () {
        const { sync, queries } = makeSync({ localMaxId: 0, network: 'testnet' });
        sinon.stub(sync, '_httpGet').callsFake(async () => ({ rows: [], watermark: 1 }));
        await sync._bootstrapTable('attestation_responses');
        const purge = queries.filter(q => /^DELETE FROM attestation_responses WHERE network <> \?/.test(q.sql));
        assert.strictEqual(purge.length, 1,
            're-pointing an indexer at a hub on another network must clear the rows the previous hub ' +
            'served; the scope resolves only because the mirror table carries `network` (D54)');
        assert.deepStrictEqual(purge[0].args, ['testnet']);
    });

    // ── the frozen grace and its regtest-only seam ──

    it('the attestResponse grace is 120s and is resolved onto the constructor', function () {
        assert.strictEqual(FROZEN.attestResponse, 120,
            'the barrier only has to cover ordinary stream lag: the real forward margin rides in the ' +
            'row signed effective_time, so this value is not what makes a response bind at the right block');
        const { sync } = makeSync({ network: 'mainnet' });
        assert.strictEqual(sync.attestResponseWatermarkGraceS, 120);
        assert.deepStrictEqual(sync._attestResponseWaiters, [],
            'the waiter array is the seam the barrier row builds waitForAttestationResponseSync on');
    });

    it('honours HUB_SYNC_ATTEST_RESPONSE_GRACE_S on regtest', function () {
        process.env[GRACE_ENV] = '3';
        const { sync } = makeSync({ network: 'regtest' });
        assert.strictEqual(sync.attestResponseWatermarkGraceS, 3,
            'regtest blocks are stamped at about now, so without this seam a regtest venue cannot bind ' +
            'a response for a full forward margin per attestation and the acceptance tests are undrivable');
    });

    it('IGNORES the override off regtest, with a warning, and keeps the frozen value', function () {
        process.env[GRACE_ENV] = '3';
        const warn = sinon.stub(console, 'log');
        const { sync } = makeSync({ network: 'mainnet' });
        assert.strictEqual(sync.attestResponseWatermarkGraceS, 120,
            'a per-node grace forks settlement: one node advances past a block a response binds at while ' +
            'another defers, so the frozen constant must win off regtest');
        assert.ok(warn.getCalls().some(c => String(c.args[0]).indexOf(GRACE_ENV) !== -1 &&
                                            /IGNORED/.test(String(c.args[0]))),
            'the ignore must be loud, or an operator keeps believing the value they set is in force');
    });

    it('THROWS on a malformed regtest override rather than stamping NaN', function () {
        process.env[GRACE_ENV] = 'soon';
        assert.throws(() => makeSync({ network: 'regtest' }),
            new RegExp(GRACE_ENV + '="soon"'),
            'an unparseable value yields NaN, every `blockTime + NaN` comparison is false, and the ' +
            'barrier wedges the tip permanently; it must fail at startup instead');
    });
});

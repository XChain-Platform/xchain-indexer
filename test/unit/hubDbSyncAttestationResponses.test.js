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
                          'effective_time', 'signer_pubkeys', 'signatures', 'widen', 'finalized_at'];

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
        finalized_at: 1767225480
    };
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
        const cols = /\(([^)]*)\) VALUES/.exec(sql)[1].split(',').map(s => s.trim());
        assert.ok(cols.indexOf('id') === -1,
            'the hub id must not be written: hub ids are hub-LOCAL (every hub that verifies the ' +
            'gossiped result inserts its own row), so a wire id can collide with a locally-assigned ' +
            'PK and INSERT IGNORE would silently drop a real response. Generated SQL was: ' + sql);
        assert.ok(cols.indexOf('network') !== -1 && cols.indexOf('request_id') !== -1,
            'the natural key (network, request_id) must be written, or the row has no identity');
        assert.strictEqual(inserts[0].args.length, cols.length, 'one bound arg per written column');
        assert.ok(inserts[0].args.indexOf(row.id) === -1, 'the hub id must not be bound as a value either');
        assert.ok(/^INSERT IGNORE INTO attestation_responses /.test(sql),
            'insert-only table: a re-delivered, re-gossiped or replayed row is a no-op on the natural ' +
            'key, so the apply must stay a plain INSERT IGNORE with no in-place upgrade clause');
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

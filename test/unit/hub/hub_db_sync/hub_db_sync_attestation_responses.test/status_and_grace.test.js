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

const assert = require('assert');
const sinon  = require('sinon');

const {
    HubDbSync, FROZEN, GRACE_ENV, RESPONSE_COLUMNS, CHECKPOINT_COLUMNS,
    makeSync, insertFor, responseRow, splitAssignments, makeStoredSync,
} = require('./helpers/fixtures.js');

describe('HubDbSync attestation_responses mirror registration @regression @tier1', function () {
    afterEach(function () {
        delete process.env[GRACE_ENV];
        sinon.restore();
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
            await sync.applyRow(table, { id: 5, network: 'regtest', batch_action_index: 7 });
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
            { configured: false, connected: false, bootstrapped: false, streamWatermark: null, tables: {}, heights: {} });
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
});

describe('HubDbSync attestation_responses mirror registration @regression @tier1', function () {
    afterEach(function () {
        delete process.env[GRACE_ENV];
        sinon.restore();
    });

    it('mirrorStatus reflects the stream watermark advancing, HUB_STATE_TABLES included', async function () {
        const { sync } = makeSync();
        assert.strictEqual(sync.mirrorStatus().streamWatermark, 0);
        sync.advanceWatermark(1700000000);
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

    // ── the cursor that follows from the id strip ──

    it('bootstraps attestation_responses from since_id 0 even when the local table holds high ids', async function () {
        const { sync } = makeSync({ localMaxId: 987654 });
        const paths = [];
        sinon.stub(sync, 'httpGet').callsFake(async (path) => { paths.push(path); return { rows: [], watermark: 1 }; });

        await sync.bootstrapTable('attestation_responses');

        assert.strictEqual(paths.length, 1, 'one page fetched (an empty page is a short page)');
        assert.ok(/since_id=0&/.test(paths[0]),
            'the cursor must re-page from 0: the local ids are LOCALLY assigned (the strip above), so ' +
            'MAX(local id) is not a position in the followed hub id space and since_id=987654 would ask ' +
            'for rows past the end of that hub table and drain zero rows forever. Path was: ' + paths[0]);
    });
});

describe('HubDbSync attestation_responses mirror registration @regression @tier1', function () {
    afterEach(function () {
        delete process.env[GRACE_ENV];
        sinon.restore();
    });

    it('bootstraps state_checkpoints from MAX(local id), the id-parity cursor control', async function () {
        const { sync } = makeSync({ localMaxId: 987654 });
        const paths = [];
        sinon.stub(sync, 'httpGet').callsFake(async (path) => { paths.push(path); return { rows: [], watermark: 1 }; });

        await sync.bootstrapTable('state_checkpoints');

        assert.ok(/since_id=987654&/.test(paths[0]),
            'state_checkpoints keeps hub-id parity and must page incrementally; if this also re-pages, ' +
            'the FULL_REPAGE assertion above proves nothing. Path was: ' + paths[0]);
    });

    it('purges foreign-network rows before reading the cursor, which needs the network column', async function () {
        const { sync, queries } = makeSync({ localMaxId: 0, network: 'testnet' });
        sinon.stub(sync, 'httpGet').callsFake(async () => ({ rows: [], watermark: 1 }));
        await sync.bootstrapTable('attestation_responses');
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
});

describe('HubDbSync attestation_responses mirror registration @regression @tier1', function () {
    afterEach(function () {
        delete process.env[GRACE_ENV];
        sinon.restore();
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

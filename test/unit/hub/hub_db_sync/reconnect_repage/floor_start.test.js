// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The two round-2 guards on the owed re-page: the stall detector never restarts a re-page
// that is still moving, and a bounded mirror's same-instance price re-page starts at its
// floor, with every case that must still page from zero.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub/hub_schema_version');
const { FIXTURES, makeSync, ready } = require('./helpers/fake_mirror.js');

// Rows 1 to 3 sit below the floor; rows 4 to 6 are the ones a bounded mirror applies.
// Row 1 is the only round of OLD/USD, so the drain applies it as that pair's held
// predecessor (a row the VM's per-pair latest-price read selects); it shares round 4 with
// DOGE/USD so the bound check counts no pre-horizon round as dropped. Rows 2 and 3 are
// skipped placeholders.
const HORIZON = 5000 + 1500 * 600;
function floored() {
    const ctx = makeSync();
    for (let i = 1; i <= 6; i++) {
        const row = Object.assign(FIXTURES.price_snapshots(i), { id: i });
        if (i === 1) Object.assign(row, { coin_pair: 'OLD/USD', round_number: 4, block_timestamp: 101 });
        else if (i <= 3) Object.assign(row, { status: 'skipped', block_timestamp: 100 + i });
        ctx.hub.price_snapshots.push(row);
    }
    ctx.sync.getPriceMirrorHorizon = async () => HORIZON;
    return ctx;
}
const oldPair = (ctx) => ctx.local.price_snapshots.filter(r => r.coin_pair === 'OLD/USD').length;
async function again(ctx, frame) {
    ctx.sync.resetOnSocketClose();
    ctx.seen.pages.length = 0;
    ctx.sync.adoptReadyFrame({}, frame || { type: 'ready', hub_instance_id: 'hub-a', max_ids: {} });
    assert.strictEqual(await ctx.sync.bootstrapTable('price_snapshots'), 9000);
    return ctx.seen.pages[0].since;
}

describe('HubDbSync stall detector spares a re-page that is still moving @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    function stalled() {
        const ctx = makeSync();
        const s = ctx.sync;
        s.running = true;
        s.watermarkStallMs = 180000;
        s.watermarkStallExitMs = 300000;
        s._lastWatermarkAdvanceAt = 0;
        s._hubTipTs = 9000;
        s.streamWatermark = 100;
        const drive = sinon.stub(s, 'driveResync');
        return { s, drive };
    }

    it('never forces a resync while drain ticks keep moving, and does once they stop', function () {
        const { s, drive } = stalled();
        s._bootstrapping = true;
        for (let t = 200000; t <= 4000000; t += 45000) {
            s._bootstrapProgressTicks = (s._bootstrapProgressTicks || 0) + 1;
            assert.strictEqual(s.checkWatermarkStall(t), 'draining');
        }
        assert.strictEqual(drive.callCount, 0, 'a 63-minute re-page is never restarted');
        // The drain stops moving: one stall window later the detector acts.
        s.checkWatermarkStall(4000000);
        s.checkWatermarkStall(4000000 + 180000);
        assert.strictEqual(drive.callCount, 1);
    });

    it('still resyncs a frozen mirror when no bootstrap is running', function () {
        const { s, drive } = stalled();
        assert.strictEqual(s.checkWatermarkStall(200000), 'resync');
        assert.strictEqual(drive.callCount, 1);
    });
});

describe('HubDbSync price re-page starts at the mirror floor on a same-instance reconnect @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('stops retrying a failed page once stop() runs', async function () {
        const ctx = makeSync();
        ctx.sync.running = true;
        for (let i = 1; i <= 3; i++)
            ctx.hub.price_snapshots.push(Object.assign(FIXTURES.price_snapshots(i), { id: i }));
        ready(ctx.sync);
        ctx.sync.httpGet.callsFake(async () => {
            const error = new Error('HTTP 500');
            error.statusCode = 500;
            throw error;
        });
        ctx.sync.waitForSnapshotRetry = sinon.stub().callsFake(async () => { ctx.sync.running = false; });

        assert.strictEqual(await ctx.sync.bootstrapTable('price_snapshots'), null);
        assert.strictEqual(ctx.sync.httpGet.callCount, 1);
    });

    it('retries failed pages at their cursor and restarts only for a new connection', async function () {
        this.timeout(30000);
        const ctx = makeSync();
        ctx.sync.running = true;                     // as start() leaves it
        const rows = 10005;
        for (let i = 1; i <= rows; i++)
            ctx.hub.price_snapshots.push(Object.assign(FIXTURES.price_snapshots(i), { id: i }));
        ready(ctx.sync);

        let connection = 1;
        let failures = 0;
        ctx.sync.httpGet.callsFake(async path => {
            const match = /since_id=(\d+)&limit=(\d+)/.exec(path);
            const since = Number(match[1]);
            const limit = Number(match[2]);
            ctx.seen.pages.push({ table: 'price_snapshots', since });
            if (connection === 1 && since === 10000) {
                if (failures++ < 2) {
                    const error = new Error('HTTP 500');
                    error.statusCode = 500;
                    throw error;
                }
                ctx.sync.resetOnSocketClose();
                connection = 2;
                const error = new Error('socket replaced');
                error.statusCode = 500;
                throw error;
            }
            if (connection === 2 && since === 10000 && failures++ < 5) {
                const error = new Error('HTTP 500');
                error.statusCode = 500;
                throw error;
            }
            return {
                schema_version: HUB_SCHEMA_VERSION,
                watermark: 9000,
                rows: ctx.hub.price_snapshots.filter(row => row.id > since).slice(0, limit)
                    .map(row => Object.assign({}, row))
            };
        });
        const wait = sinon.stub().resolves();
        ctx.sync.waitForSnapshotRetry = wait;

        assert.strictEqual(await ctx.sync.bootstrapTable('price_snapshots'), null);
        ctx.sync.adoptReadyFrame({}, { type: 'ready', hub_instance_id: 'hub-a', max_ids: { price_snapshots: rows } });
        assert.strictEqual(await ctx.sync.bootstrapTable('price_snapshots'), 9000);

        assert.deepStrictEqual(ctx.seen.pages.map(page => page.since),
            [0, 10000, 10000, 10000, 0, 10000, 10000, 10000]);
        assert.strictEqual(ctx.seen.pages.filter(page => page.since === 0).length, 2,
            'each connection starts one full re-page');
        assert.deepStrictEqual(wait.getCalls().map(call => call.args[1]), [0, 1, 0, 1]);
        assert.strictEqual(ctx.local.price_snapshots.length, rows);
        assert.strictEqual(ctx.sync.repageOwedSeq('price_snapshots'), undefined);
    });

    it('starts below the lowest applied id, settles the owed re-page and keeps the floor', async function () {
        const ctx = floored();
        ready(ctx.sync);
        await ctx.sync.bootstrapTable('price_snapshots');
        ctx.hub.price_snapshots[4].batch_block_time = 5500;           // an in-place stamp above the floor
        assert.strictEqual(await again(ctx), 3);
        assert.strictEqual(ctx.sync.repageOwedSeq('price_snapshots'), undefined);
        assert.strictEqual(ctx.local.price_snapshots.find(r => r.round_number === 5).batch_block_time, 5500);
        assert.strictEqual(ctx.sync._priceMirrorFloorTs, 5000, 'a floor-started drain still reports a bounded mirror');
    });

    it('a floor-started reconcile keeps a held predecessor below the floor (verifier m6)', async function () {
        const ctx = floored();
        ready(ctx.sync);
        await ctx.sync.bootstrapTable('price_snapshots');
        assert.strictEqual(oldPair(ctx), 1, 'the held predecessor is applied by the full drain');
        assert.strictEqual(await again(ctx), 3);
        assert.strictEqual(oldPair(ctx), 1, 'a drain that never served it must not judge it');
    });
});

describe('HubDbSync price re-page from zero: every case the floor start must not cover @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('re-pages from zero after an instance change, a forced resync or a schema refusal', async function () {
        const ctx = floored();
        ready(ctx.sync);
        await ctx.sync.bootstrapTable('price_snapshots');
        assert.strictEqual(await again(ctx, { type: 'ready', hub_instance_id: 'hub-b', max_ids: {} }), 0);
        ctx.sync.ws = { terminate() {} };
        ctx.sync.driveResync('test');
        assert.strictEqual(await again(ctx, { type: 'ready', hub_instance_id: 'hub-b', max_ids: {} }), 0);
        await ctx.sync.handleRowEvent({ type: 'row:inserted', table: 'price_snapshots', schema_version: HUB_SCHEMA_VERSION + 1, row: { id: 7 } });
        assert.strictEqual(await again(ctx, { type: 'ready', hub_instance_id: 'hub-b', max_ids: {} }), 0);
    });

    it('re-pages from zero when the floor has moved down (verifier m7)', async function () {
        const ctx = floored();
        ready(ctx.sync);
        await ctx.sync.bootstrapTable('price_snapshots');
        // A lower horizon puts the floor below the one the start was recorded under, so rows
        // between the two floors now count and sit below the recorded id.
        ctx.sync.getPriceMirrorHorizon = async () => HORIZON - 1000;
        assert.strictEqual(await again(ctx), 0);
    });

    it('a forced resync with no socket forgets the floor start (verifier m8)', async function () {
        const ctx = floored();
        ready(ctx.sync);
        await ctx.sync.bootstrapTable('price_snapshots');
        ctx.sync.ws = null;
        sinon.stub(ctx.sync, 'bootstrapAll').resolves();
        ctx.sync.driveResync('test');
        // The direct re-bootstrap runs on the same connection: no ready frame clears anything.
        ctx.seen.pages.length = 0;
        await ctx.sync.bootstrapTable('price_snapshots');
        assert.strictEqual(ctx.seen.pages[0].since, 0);
    });

    it('a consumer with no mirror bound re-pages from zero', async function () {
        const ctx = floored();
        ctx.sync.getPriceMirrorHorizon = undefined;
        ready(ctx.sync);
        await ctx.sync.bootstrapTable('price_snapshots');
        assert.strictEqual(await again(ctx), 0);
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub/hub_schema_version');
const observability = require('../../../../src/observability/index.js');
const fakeMirror = require('./reconnect_repage/helpers/fake_mirror.js');

function makeSync() {
    const queries = [];
    const sync = new HubDbSync({ doQuery: sinon.stub().callsFake(async sql => {
        queries.push(sql);
        if (/MAX\(id\)/.test(sql)) throw new Error('local MAX(id) must not be read as a cursor');
        return [];
    }) }, { hubUrl: 'http://hub-a.test', network: 'regtest' });
    return { sync, queries };
}

describe('HubDbSync per-connection drain positions @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('starts every table at zero without reading local MAX(id)', async function () {
        const { sync, queries } = makeSync();
        const cursor = await sync.resolveDrainCursor('state_checkpoints', 'regtest');
        assert.strictEqual(cursor.lastId, 0);
        assert.strictEqual(queries.length, 0);
    });

    it('retains positions only when the ready frame names the same hub instance', function () {
        const { sync } = makeSync();
        sync._drainPositions.state_checkpoints = 8;
        sync.adoptReadyFrame({}, { type: 'ready', hub_instance_id: 'hub-a' });
        assert.strictEqual(sync._drainPositions.state_checkpoints, undefined, 'the first connection starts at zero');

        sync._drainPositions.state_checkpoints = 12;
        sync.adoptReadyFrame({}, { type: 'ready', hub_instance_id: 'hub-a' });
        assert.strictEqual(sync._drainPositions.state_checkpoints, 12, 'an equal instance resumes');

        sync.hubUrl = 'http://hub-b.test';
        sync.adoptReadyFrame({}, { type: 'ready', hub_instance_id: 'hub-b' });
        assert.strictEqual(sync._drainPositions.state_checkpoints, undefined, 'an address move with a new instance resets');
    });

    it('resets on every reconnect to an older hub that omits hub_instance_id', function () {
        const { sync } = makeSync();
        sync._drainPositions.state_checkpoints = 4;
        sync.adoptReadyFrame({}, { type: 'ready' });
        assert.strictEqual(sync._drainPositions.state_checkpoints, undefined);
        sync._drainPositions.state_checkpoints = 5;
        sync.adoptReadyFrame({}, { type: 'ready' });
        assert.strictEqual(sync._drainPositions.state_checkpoints, undefined);
    });

    it('advances only after a row is handled and leaves a failed row retryable', async function () {
        const { sync } = makeSync();
        const drain = { table: 'state_checkpoints', lastId: 0, priceHorizon: 0, applied: 0,
                        applyErrors: 0, priceSkipped: 0 };
        sinon.stub(sync, 'applyRow').onFirstCall().resolves().onSecondCall().rejects(new Error('write failed'));
        sinon.stub(sync, 'recordServedRow');
        assert.strictEqual(await sync.applyPendingRow(drain, { id: 7 }, false), true);
        assert.strictEqual(sync._drainPositions.state_checkpoints, 7);
        assert.strictEqual(await sync.applyPendingRow(drain, { id: 8 }, false), false);
        assert.strictEqual(sync._drainPositions.state_checkpoints, 7);
    });

    it('resets a position above max_ids and purges nothing', async function () {
        const { sync, queries } = makeSync();
        sync._drainPositions.state_checkpoints = 50;
        sync._readyMaxIds = { state_checkpoints: 20 };
        const cursor = await sync.resolveDrainCursor('state_checkpoints', 'regtest');
        assert.strictEqual(cursor.lastId, 0);
        assert.strictEqual(sync._drainPositions.state_checkpoints, 0);
        assert.ok(!queries.some(q => /^DELETE /.test(q)));
    });

    it('a bootstrap pages from its wire position with no MAX(id) cursor read', async function () {
        const { sync, queries } = makeSync();
        sinon.stub(sync, 'localColumns').resolves(new Set(['id', 'chain']));
        sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
        sinon.stub(sync, 'applyRow').resolves();
        const httpGet = sinon.stub(sync, 'httpGet').resolves({ schema_version: HUB_SCHEMA_VERSION, rows: [{ id: 3, chain: 'BTC' }], watermark: 9 });

        assert.strictEqual(await sync.bootstrapTable('state_checkpoints'), 9);
        assert.match(httpGet.firstCall.args[0], /since_id=0/);
        assert.strictEqual(sync._drainPositions.state_checkpoints, 3);
        assert.ok(!queries.some(q => /MAX\(id\)/.test(q)));
    });
});

// The ready frame's max_ids is a snapshot taken at subscribe time, and the hub keeps
// appending price rounds after it. A drain on the live socket therefore ends above that
// snapshot, and a later pass on the SAME socket must resume from its position instead of
// judging it against the stale ceiling and re-paging the whole price table from id 0.
describe('HubDbSync same-connection position above a stale ready ceiling @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    const CEILING = 3;          // what the ready frame advertised
    const APPENDED = 5;         // what the hub holds by the time the first drain ends

    async function drainedAboveCeiling() {
        const ctx = fakeMirror.makeSync();
        fakeMirror.seedHub(ctx.hub, 'price_snapshots', APPENDED);
        ctx.sync.adoptReadyFrame({}, { type: 'ready', hub_instance_id: 'hub-a',
                                       max_ids: { price_snapshots: CEILING } });
        assert.strictEqual(await ctx.sync.bootstrapTable('price_snapshots'), 9000);
        assert.strictEqual(ctx.seen.pages[0].since, 0, 'the owed per-connection re-page starts at zero');
        assert.strictEqual(ctx.sync._drainPositions.price_snapshots, APPENDED);
        assert.strictEqual(ctx.sync.repageOwedSeq('price_snapshots'), undefined, 'the owed mark settled');
        // One more round lands after the drain, still with no new ready frame.
        ctx.hub.price_snapshots.push(Object.assign(fakeMirror.FIXTURES.price_snapshots(APPENDED + 1),
                                                   { id: APPENDED + 1 }));
        ctx.seen.pages.length = 0;
        return ctx;
    }

    it('a second pass on the same socket resumes from its position, not from id 0', async function () {
        const ctx = await drainedAboveCeiling();
        const warn = sinon.stub(observability.getLogger(), 'warn');

        assert.strictEqual(await ctx.sync.bootstrapTable('price_snapshots'), 9000);

        assert.strictEqual(ctx.seen.pages[0].since, APPENDED, 'the retry pass pages from its wire position');
        assert.ok(!warn.args.some(a => /sits above the hub ceiling/.test(String(a[0]))),
                  'no stale-ceiling reset is logged');
        assert.strictEqual(ctx.sync._drainPositions.price_snapshots, APPENDED + 1);
        assert.strictEqual(ctx.local.price_snapshots.length, APPENDED + 1);
    });

    it('still resets the same position once the connection that read it is gone', async function () {
        const ctx = await drainedAboveCeiling();
        // The socket closes (the epoch bumps) and the position is carried, with the old
        // ceiling still in place: nothing proves the position belongs to the hub now.
        ctx.sync._wsEpoch++;
        const warn = sinon.stub(observability.getLogger(), 'warn');

        const cursor = await ctx.sync.resolveDrainCursor('price_snapshots', null);

        assert.strictEqual(cursor.lastId, 0);
        assert.strictEqual(ctx.sync._drainPositions.price_snapshots, 0);
        assert.ok(warn.args.some(a => /drain position 5 sits above the hub ceiling 3/.test(String(a[0]))));
    });

    it('still resets a position some other writer set on this connection', async function () {
        const ctx = await drainedAboveCeiling();
        ctx.sync._drainPositions.price_snapshots = APPENDED + 40;
        const cursor = await ctx.sync.resolveDrainCursor('price_snapshots', null);
        assert.strictEqual(cursor.lastId, 0);
        assert.strictEqual(ctx.sync._drainPositions.price_snapshots, 0);
    });
});

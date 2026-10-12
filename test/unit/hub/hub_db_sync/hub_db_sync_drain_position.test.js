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

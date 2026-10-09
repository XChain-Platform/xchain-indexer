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
        return [];
    }) }, { hubUrl: 'http://hub-a.test', network: 'regtest' });
    sinon.stub(sync, 'localColumns').resolves(new Set(['id', 'chain']));
    sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
    return { sync, queries };
}

describe('HubDbSync state_checkpoints resume after a hub id reset @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('syncs new rows whose ids sit below the pre-reset cursor once the hub ids restart at 1', async function () {
        const { sync, queries } = makeSync();
        const applied = [];
        sinon.stub(sync, 'applyRow').callsFake(async (table, row) => { applied.push(row.id); });
        const paths = [];
        const httpGet = sinon.stub(sync, 'httpGet').callsFake(async path => {
            paths.push(path);
            return { schema_version: HUB_SCHEMA_VERSION, rows: [{ id: 1, chain: 'BTC' }, { id: 2, chain: 'BTC' }, { id: 3, chain: 'BTC' }], watermark: 9 };
        });

        sync._drainPositions.state_checkpoints = 50;
        sync._readyMaxIds = { state_checkpoints: 3 };

        assert.strictEqual(await sync.bootstrapTable('state_checkpoints'), 9);
        assert.match(httpGet.firstCall.args[0], /since_id=0&/, 'the stale cursor 50 must not become since_id');
        assert.deepStrictEqual(applied, [1, 2, 3]);
        assert.strictEqual(sync._drainPositions.state_checkpoints, 3);
        assert.ok(!queries.some(q => /^DELETE /.test(q)), 'a cursor reset deletes no mirror row');
        assert.strictEqual(paths.length, 1);
    });

    it('keeps resuming from the cursor while the hub ceiling is still at or above it', async function () {
        const { sync } = makeSync();
        sinon.stub(sync, 'applyRow').resolves();
        const httpGet = sinon.stub(sync, 'httpGet').resolves({ schema_version: HUB_SCHEMA_VERSION, rows: [], watermark: 1 });

        sync._drainPositions.state_checkpoints = 50;
        sync._readyMaxIds = { state_checkpoints: 50 };

        await sync.bootstrapTable('state_checkpoints');
        assert.match(httpGet.firstCall.args[0], /since_id=50&/);
    });
});

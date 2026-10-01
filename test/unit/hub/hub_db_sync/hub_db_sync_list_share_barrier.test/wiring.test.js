// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

require('./methods.test.js');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const { CROSS_CHAIN_TABLES, REFUSED_ROW_NAMES } =
    require('../../../../../src/hub/hub_db_sync/mirror_tables.js');

const OUR_CHAIN = '1'.repeat(64);
const OLD_CHAIN = '2'.repeat(64);

function makeSync() {
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        if (/information_schema\.TABLES/i.test(sql)) return [{ TABLE_NAME: args[0] }];
        return [];
    });
    return new HubDbSync({ doQuery }, {
        hubUrl: 'http://hub.test', coin: 'BTC', network: 'regtest'
    });
}

describe('list share mirror wiring @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('registers list_snapshots as a fenced mirror with its operator-facing row name', function () {
        assert.ok(CROSS_CHAIN_TABLES.includes('list_snapshots'));
        assert.deepStrictEqual(REFUSED_ROW_NAMES.list_snapshots,
            { column: 'snapshot_id', tag: 'XLISTSHARE' });

        const sync = makeSync();
        sync._expectedBtcChainId = OUR_CHAIN;
        assert.strictEqual(sync.refuseForeignChainRow('list_snapshots', {
            snapshot_id: 'shared-list-1', btc_chain_id: OLD_CHAIN
        }), true);
        assert.strictEqual(sync.refuseForeignChainRow('list_snapshots', {
            snapshot_id: 'shared-list-2', btc_chain_id: OUR_CHAIN
        }), false);
    });

    it('drains list_snapshots before price_snapshots', async function () {
        const sync = makeSync();
        const order = [];
        sinon.stub(sync, 'bootstrapTable').callsFake(async (table) => {
            order.push(table);
            return 900;
        });

        await sync.bootstrapAll();

        assert.ok(order.includes('list_snapshots'));
        assert.ok(order.indexOf('list_snapshots') < order.indexOf('price_snapshots'));
    });

    it('arms after a complete list snapshot drain and refreshes after a live row', async function () {
        const sync = makeSync();
        const refresh = sinon.stub(sync, 'refreshListShareSyncState').resolves();
        sinon.stub(sync, 'releaseSnapshotWaiters').resolves();

        await sync.armBarriersAfterDrain({ table: 'list_snapshots' });
        assert.ok(refresh.calledWithExactly(true));

        refresh.resetHistory();
        sinon.stub(sync, 'maybeAdoptHubChainId').resolves();
        sinon.stub(sync, 'applyRow').resolves(true);
        sinon.stub(sync, 'reportRefusedChainRows');
        sinon.stub(sync, 'reportRefusedNetworkRows');
        await sync.handleRowEvent({
            type: 'row:inserted', table: 'list_snapshots',
            row: { snapshot_id: 'shared-list-3', btc_chain_id: OUR_CHAIN }
        });
        assert.ok(refresh.calledWithExactly());
    });

    it('reports list_snapshots as height-keyed and ships its mirror DDL', function () {
        const sync = makeSync();
        assert.strictEqual(sync.mirrorStatus().tables.list_snapshots, null);

        const script = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '..',
            'bin', 'sync-hub-mirror-client.sh'), 'utf8');
        assert.match(script, /SQL_FILES="[^"]*\blist_snapshots\.sql\b[^"]*"/);
    });
});

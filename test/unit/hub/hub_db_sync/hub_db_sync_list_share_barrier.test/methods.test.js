// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const observability = require('../../../../../src/observability/index.js');
const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

function makeSync(options = {}) {
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        if (/information_schema\.TABLES/i.test(sql))
            return options.tablePresent === false ? [] : [{ TABLE_NAME: args[0] }];
        if (/FROM list_snapshots/i.test(sql)) {
            if (options.readError) throw options.readError;
            return options.listRows || [];
        }
        return [];
    });
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'enabled', coin: 'BTC', network: 'regtest' });
    return { sync, doQuery };
}

describe('list share sync barrier @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('stays closed before bootstrap even when the height watermark is sufficient', function () {
        const { sync } = makeSync();
        sync.heightWatermarks = { list_snapshots: { BTC: 96 } };

        assert.strictEqual(sync.listShareSyncSatisfied(100), false);
    });

    it('stays closed when the height entry is absent or shorter than B minus four', function () {
        const { sync } = makeSync();
        sync.listShareBootstrapped = true;
        sync.listShareMirrorEmpty = false;

        assert.strictEqual(sync.listShareSyncSatisfied(100), false);
        sync.heightWatermarks = { list_snapshots: { BTC: 95 } };
        assert.strictEqual(sync.listShareSyncSatisfied(100), false);
    });

    it('opens for a bootstrapped empty mirror without a height entry', async function () {
        const { sync } = makeSync({ listRows: [] });
        sync._bootstrapDrained = true;

        await sync.refreshListShareSyncState();

        assert.strictEqual(sync.listShareMirrorEmpty, true);
        assert.strictEqual(sync.listShareSyncSatisfied(100), true);
    });

    it('closes after the first mirror row arrives until its height is published', async function () {
        const options = { listRows: [] };
        const { sync } = makeSync(options);
        sync._bootstrapDrained = true;
        await sync.refreshListShareSyncState();
        assert.strictEqual(sync.listShareSyncSatisfied(100), true);

        options.listRows = [{ present: 1 }];
        await sync.refreshListShareSyncState();

        assert.strictEqual(sync.listShareMirrorEmpty, false);
        assert.strictEqual(sync.listShareSyncSatisfied(100), false);
    });

    it('stays closed for an unbootstrapped empty mirror', async function () {
        const { sync } = makeSync({ listRows: [] });

        await sync.refreshListShareSyncState(false);

        assert.strictEqual(sync.listShareMirrorEmpty, true);
        assert.strictEqual(sync.listShareSyncSatisfied(100), false);
    });

    it('opens at B minus four and remains open above it', function () {
        const { sync } = makeSync();
        sync.listShareBootstrapped = true;
        sync.heightWatermarks = { list_snapshots: { BTC: 96 } };

        assert.strictEqual(sync.listShareSyncSatisfied(100), true);
        sync.heightWatermarks.list_snapshots.BTC = 97;
        assert.strictEqual(sync.listShareSyncSatisfied(100), true);
    });

    it('ends a timed-out waiter message with the list snapshot height tail', async function () {
        const { sync } = makeSync({ listRows: [{ present: 1 }] });
        sync.listShareBootstrapped = true;
        sync.heightWatermarks = { list_snapshots: { BTC: 95 } };

        await assert.rejects(sync.waitForListShareSync(20, 100),
            /list share sync barrier timed out after 20ms waiting for block_height 100 \(admission height list_snapshots\.BTC at 95, needs 96\)$/);
        assert.strictEqual(sync._listShareWaiters.length, 0);
    });

    it('keeps bootstrap closed and reports an absent table', async function () {
        const warn = sinon.stub(observability.getLogger(), 'warn');
        const { sync } = makeSync({ tablePresent: false });
        sync._bootstrapDrained = true;

        await sync.refreshListShareSyncState();

        assert.strictEqual(sync.listShareBootstrapped, false);
        assert.ok(warn.calledWithMatch(/no list_snapshots table/));
    });

    it('releases a waiter when the height watermark advances', async function () {
        const { sync } = makeSync();
        sync.listShareBootstrapped = true;
        sync.noteHeights({ list_snapshots: { BTC: 95 } });
        const pending = sync.waitForListShareSync(5000, 100);
        assert.strictEqual(sync._listShareWaiters.length, 1);

        sync.noteHeights({ list_snapshots: { BTC: 96 } });

        assert.strictEqual(await pending, true);
        assert.strictEqual(sync._listShareWaiters.length, 0);
    });
});

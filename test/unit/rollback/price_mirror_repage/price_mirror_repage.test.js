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
// A BTC reorg purges mirrored price_snapshots rows the hub still holds, and the mirror only
// streams new rows after its bootstrap, so the purged rounds never come back unless the
// rollback owes and starts a price_snapshots re-page once its transaction has committed.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../../fixtures/mocks');
const Rollback = require('../../../../src/rollback/index.js');
const sweepSql = require('../../../../src/db/rollback/sweeps.js');
const { getLogger } = require('../../../../src/observability/index.js');

// A rollback whose every write step is a no-op except the price purge and the commit,
// each recording its place in `order`. The scope is empty, so only the purge matters.
function makeRollback(coin, hubDbSync, order) {
    const indexer = createMockIndexer();
    indexer.hubDbSync = hubDbSync;
    const rollback = new Rollback(indexer);
    rollback.config = Object.assign({}, rollback.config, { COIN: coin });
    for (const step of ['reverseCooldownMaturities', 'restoreInPlaceFlips', 'recomputeAttestationValidatorStats',
        'refreshDerivedProjections']) {
        rollback[step] = async () => {};
    }
    rollback.purgeOrphanedTables = async (block) => { await rollback.purgeOrphanedPriceSnapshots(block); };
    rollback.stageHubRetractions = async () => ({ retractionGeneration: null, stagedRetractions: [] });
    rollback.commitAndInvalidateCaches = async () => { order.push('commit'); };
    return rollback;
}

function run(rollback) {
    const scope = { firstActionIndex: null, lastActionIndex: null, unlandedAttestBatches: [], retractedPriceBatches: [] };
    return rollback.applyRollbackWrites(100, scope, [], [], []);
}

function fakeSync(order, bootstrapTable) {
    return {
        markRepageOwed: sinon.spy(tables => order.push('owed:' + tables.join(','))),
        bootstrapTable: sinon.spy(bootstrapTable || (async table => { order.push('bootstrap:' + table); return 0; }))
    };
}

describe('Rollback price mirror re-page @regression @tier3', function () {
    let order, warn;

    beforeEach(function () {
        order = [];
        warn = sinon.stub(getLogger(), 'warn');
        sinon.stub(sweepSql, 'purgeOrphanedPriceSnapshots').callsFake(async () => { order.push('purge'); });
    });

    afterEach(function () {
        sinon.restore();
    });

    it('owes and starts the price_snapshots re-page only after the commit', async function () {
        const sync = fakeSync(order);
        await run(makeRollback('BTC', sync, order));
        assert.deepStrictEqual(order, ['purge', 'commit', 'owed:price_snapshots', 'bootstrap:price_snapshots']);
        assert.strictEqual(sync.bootstrapTable.callCount, 1);
    });

    it('launches nothing when the purge ran but the commit threw', async function () {
        const sync = fakeSync(order);
        const rollback = makeRollback('BTC', sync, order);
        rollback.commitAndInvalidateCaches = async () => { throw new Error('commit failed'); };
        await assert.rejects(() => run(rollback), /commit failed/);
        assert.strictEqual(sync.markRepageOwed.callCount, 0);
        assert.strictEqual(sync.bootstrapTable.callCount, 0);
    });

    it('launches nothing on a non-BTC coin', async function () {
        const sync = fakeSync(order);
        await run(makeRollback('LTC', sync, order));
        assert.deepStrictEqual(order, ['commit']);
        assert.strictEqual(sync.markRepageOwed.callCount, 0);
        assert.strictEqual(sync.bootstrapTable.callCount, 0);
    });

    it('rolls back unchanged without a hubDbSync', async function () {
        await run(makeRollback('BTC', null, order));
        assert.deepStrictEqual(order, ['purge', 'commit']);
    });

    it('logs a rejected re-page and does not throw', async function () {
        const sync = fakeSync(order, async () => { throw new Error('hub unreachable'); });
        await run(makeRollback('BTC', sync, order));
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(sync.bootstrapTable.callCount, 1);
        assert.ok(warn.getCalls().some(c => /price_snapshots re-page failed.*hub unreachable/.test(String(c.args[0]))));
    });

    it('logs a synchronous re-page throw and does not throw', async function () {
        const sync = fakeSync(order);
        sync.markRepageOwed = sinon.stub().throws(new Error('owed boom'));
        await run(makeRollback('BTC', sync, order));
        assert.ok(warn.getCalls().some(c => /price_snapshots re-page failed.*owed boom/.test(String(c.args[0]))));
    });
});

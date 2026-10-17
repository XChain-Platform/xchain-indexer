// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig }     = require('../../../fixtures/config');
const { createMockIndexer } = require('../../../fixtures/mocks');
const Utility               = require('../../../../src/utility');
const Database              = require('../../../../src/db');
const Rollback              = require('../../../../src/rollback/index.js');

// A pool whose connections run their commands strictly in order, one event-loop turn
// apiece, the way a MariaDB socket does. A statement that runs while no transaction is
// open is autocommitted, so anything queued behind a ROLLBACK lands in `durable`.
function makeStore() {
    const durable = [];
    function connection() {
        let pending = null;
        let chain   = Promise.resolve();
        const run   = (fn) => (chain = chain.then(() => new Promise(r => setImmediate(r))).then(fn));
        return {
            beginTransaction: () => run(() => { pending = []; }),
            commit:           () => run(() => { durable.push(...pending); pending = null; }),
            rollback:         () => run(() => { pending = null; }),
            release:          async () => {},
            query:            (sql) => run(() => { (pending || durable).push(sql); return { affectedRows: 1 }; }),
        };
    }
    return { durable, pool: { getConnection: async () => connection() } };
}

function makeDb(store) {
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config: getTestConfig(), util });
    db.pool = store.pool;
    return db;
}

const turns = async (n) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

describe('reorg rollback writes are fenced to their transaction @regression @tier3', function () {
    afterEach(() => sinon.restore());

    it('a market refresh that outlives a failed rollback writes nothing', async function () {
        const store = makeStore();
        const db    = makeDb(store);
        // The sibling refresh resumes only once the failed rollback has begun its teardown.
        let teardownBegan;
        const teardown = new Promise(r => { teardownBegan = r; });
        const realRollback = db.rollbackTransaction.bind(db);
        db.rollbackTransaction = function () { teardownBegan(); return realRollback(); };
        for (const step of ['updateBalances', 'updateTokens', 'sanityCheck']) sinon.stub(db, step).resolves();
        sinon.stub(db, 'getBlockTime').resolves(1700000000);
        sinon.stub(db, 'getMarketId').callsFake(async (tick1_id) => tick1_id);
        sinon.stub(db, 'withMarketsRefreshedAfter').callsFake(async (markets) => markets);
        sinon.stub(db, 'getMarketInfo').callsFake(async (market_id) => {
            if (market_id === 1) {
                const e = new Error('injected lock wait timeout');
                e.errno = 1205;
                throw e;
            }
            await teardown;
            return { market_id, last_updated: 1700000000 };
        });
        const outcomes = [];
        const realUpdate = db.updateMarketInfo.bind(db);
        db.updateMarketInfo = async (data) => {
            try { await realUpdate(data); outcomes.push('written'); } catch (e) { outcomes.push(e.message); throw e; }
        };

        const indexer = createMockIndexer();
        indexer.indexerDb = db;
        const rollback = new Rollback(indexer);
        for (const step of ['reverseCooldownMaturities', 'deleteContractEmissions', 'restoreInPlaceFlips',
            'purgeOrphanedTables', 'recomputeAttestationValidatorStats', 'stageHubRetractions',
            'commitAndInvalidateCaches'])
            sinon.stub(rollback, step).resolves({ retractionGeneration: null, stagedRetractions: [] });

        const scope   = { firstActionIndex: 50, lastActionIndex: 60, unlandedAttestBatches: [] };
        const markets = [{ tick1_id: 1, tick2_id: 2 }, { tick1_id: 3, tick2_id: 4 }];
        await assert.rejects(rollback.runRollbackTransaction(100, scope, markets, {}, []), /injected lock wait/);
        await turns(50);

        assert.strictEqual(outcomes.length, 1, 'the sibling refresh reached its write');
        assert.match(outcomes[0], /fenced/, 'the sibling write is refused, not applied');
        assert.deepStrictEqual(store.durable, [], 'a failed rollback leaves the store untouched');
    });

});

describe('reorg rollback writes are fenced to their transaction @regression @tier3', function () {
    afterEach(() => sinon.restore());

    it('a write issued while the ROLLBACK is in flight is refused', async function () {
        const store = makeStore();
        const db    = makeDb(store);
        await db.beginTransaction();
        await db.runInTxEpoch(db.currentTxEpoch(), async () => {
            await db.doQuery('UPDATE markets SET tick1_price=? WHERE id=?', ['1', 1]);
            const teardown = db.rollbackTransaction();
            await assert.rejects(db.doQuery('UPDATE markets SET tick1_price=? WHERE id=?', ['2', 1]), /fenced/);
            await teardown;
        });
        await turns(10);
        assert.deepStrictEqual(store.durable, []);
    });

    it('a write that fetched its connection as the teardown began is refused', async function () {
        const store = makeStore();
        const db    = makeDb(store);
        await db.beginTransaction();
        await db.runInTxEpoch(db.currentTxEpoch(), async () => {
            // The statement passes the fence and awaits its connection; the teardown starts in that gap.
            const write    = db.doQuery('UPDATE markets SET tick1_price=? WHERE id=?', ['3', 1]);
            const teardown = db.rollbackTransaction();
            await assert.rejects(write, /fenced/);
            await teardown;
        });
        await turns(10);
        assert.deepStrictEqual(store.durable, []);
    });
});

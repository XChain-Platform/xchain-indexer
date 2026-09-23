/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db/vm_snapshot/memo.test.js
 *
 * The cross-chain and poll VM snapshots are built once per block pass and served
 * unchanged to every later execution in that block, never outside a pass and never for
 * a bound past the block in progress.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb }   = require('../db_queries.test/helpers/db_stub');
const blockParse   = require('../../../../src/XChainIndexer/block_parse.js');

afterEach(function () {
    sinon.restore();
});

// Rows per snapshot table, answered by SQL text so query order does not matter.
function stubSnapshotTables(db) {
    return sinon.stub(db, 'doQuery').callsFake(async (sql) => {
        const s = String(sql);
        if (s.includes('FROM cross_chain_settlements'))
            return [{ a_chain: 'LTC', a_action_index: 9, b_chain: 'BTC', b_action_index: 3 },
                    { a_chain: 'DOGE', a_action_index: 7, b_chain: 'BTC', b_action_index: 1 }];
        if (s.includes('FROM xcalls'))
            return [{ call_id: 'b'.repeat(64), result_status: 'ok', result_payload: 'x' }];
        if (s.includes('FROM poll_results'))
            return [{ poll_index: 12, option_index: 0, total_weight: '5', voter_count: 2 }];
        if (s.includes('FROM polls'))
            return [{ action_index: 12, poll_status: 'finalized', winning_option: 0,
                      total_weight: '5', total_voters: 2, decided_early: 0, tick: 'VOTE' }];
        return [];
    });
}

function inBlockPass(db, blockIndex) {
    db.blockIndex = blockIndex;
    db._vmSnapshotMemo = new Map();
}

describe('VM snapshot memo: cross-chain snapshot @regression @tier1', function () {
    it('builds every call outside a block pass', async function () {
        const db = makeDb();
        const dq = stubSnapshotTables(db);
        await db.getCrossChainDataForVM(200);
        await db.getCrossChainDataForVM(200);
        assert.strictEqual(dq.callCount, 4);
    });

    it('builds once per block pass and serves the same frozen object after', async function () {
        const db = makeDb();
        const dq = stubSnapshotTables(db);
        inBlockPass(db, 200);
        const first  = await db.getCrossChainDataForVM(200);
        const second = await db.getCrossChainDataForVM('200');
        assert.strictEqual(dq.callCount, 2);
        assert.strictEqual(second, first);
        assert.ok(Object.isFrozen(first.settled) && Object.isFrozen(first.calls['b'.repeat(64)]));
    });

    it('serves exactly what an uncached build returns, key order included', async function () {
        const db = makeDb();
        stubSnapshotTables(db);
        const fresh = await db.buildCrossChainDataForVM(200);
        inBlockPass(db, 200);
        const memo = await db.getCrossChainDataForVM(200);
        assert.deepStrictEqual(memo, fresh);
        assert.deepStrictEqual(Object.keys(memo.settled), Object.keys(fresh.settled));
    });

    it('builds fresh for a bound past the block in progress', async function () {
        const db = makeDb();
        const dq = stubSnapshotTables(db);
        inBlockPass(db, 200);
        await db.getCrossChainDataForVM(201);
        await db.getCrossChainDataForVM(201);
        assert.strictEqual(dq.callCount, 4);
        assert.strictEqual(db._vmSnapshotMemo.size, 0);
    });
});

describe('VM snapshot memo: poll snapshot @regression @tier1', function () {
    it('builds once per block pass and per tick variant', async function () {
        const db = makeDb();
        const dq = stubSnapshotTables(db);
        inBlockPass(db, 200);
        const plain = await db.getPollResultsForVM(200, false);
        const tick  = await db.getPollResultsForVM(200, true);
        assert.strictEqual(await db.getPollResultsForVM(200, false), plain);
        assert.strictEqual(await db.getPollResultsForVM(200, true), tick);
        assert.strictEqual(dq.callCount, 4);
        assert.ok(!('tick' in plain.polls['12']));
        assert.strictEqual(tick.polls['12'].tick, 'VOTE');
    });

    it('serves exactly what an uncached build returns', async function () {
        const db = makeDb();
        stubSnapshotTables(db);
        const fresh = await db.buildPollResultsForVM(200, true);
        inBlockPass(db, 200);
        assert.deepStrictEqual(await db.getPollResultsForVM(200, true), fresh);
    });
});

describe('VM snapshot memo: block pass lifetime @regression @tier1', function () {
    function passContext(runBlockPasses) {
        const indexerDb = { _vmSnapshotMemo: undefined, currentTxEpoch: () => 1,
            runInTxEpoch: (epoch, fn) => fn(), commitTransaction: sinon.stub().resolves() };
        return Object.assign(Object.create(blockParse), {
            indexerDb,
            util: { withTimeout: (p) => p },
            openBlockTransaction: async () => { indexerDb._vmSnapshotMemo = new Map(); return false; },
            runBlockPasses: runBlockPasses,
            blockWatchdogTimeout: () => 1000,
            afterBlockCommit: sinon.stub().resolves(5),
            abandonBlock: sinon.stub().resolves(),
        });
    }

    it('installs a fresh memo when the block transaction opens', async function () {
        const stale = new Map([['crossChain:200', {}]]);
        const ctx = Object.assign(Object.create(blockParse), {
            config: { NETWORK: 'regtest', COIN: 'BTC' },
            indexerDb: { beginTransaction: sinon.stub().resolves(), _vmSnapshotMemo: stale },
        });
        await ctx.openBlockTransaction(200);
        assert.ok(ctx.indexerDb._vmSnapshotMemo instanceof Map);
        assert.notStrictEqual(ctx.indexerDb._vmSnapshotMemo, stale);
        assert.strictEqual(ctx.indexerDb._vmSnapshotMemo.size, 0);
    });

    it('drops the memo when the block commits', async function () {
        let seen = null;
        const ctx = passContext(async function () { seen = ctx.indexerDb._vmSnapshotMemo; return [[], [], []]; });
        const out = await ctx.processBlock({ blockToParse: 200 }, 199, 210, null);
        assert.strictEqual(out.committed, true);
        assert.ok(seen instanceof Map);
        assert.strictEqual(ctx.indexerDb._vmSnapshotMemo, null);
    });

    it('drops the memo when the block is abandoned', async function () {
        const ctx = passContext(async () => { throw new Error('boom'); });
        const out = await ctx.processBlock({ blockToParse: 200 }, 199, 210, null);
        assert.strictEqual(out.stop, true);
        assert.strictEqual(ctx.indexerDb._vmSnapshotMemo, null);
    });
});

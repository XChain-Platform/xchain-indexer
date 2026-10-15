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
 **********************************************************************
 * The per-block market refresh covers every pair whose orders or fills changed,
 * not only the pairs an ORDER-family action touched: a COINPAY completes orders
 * and promotes its match, a SWEEP cancels orders. The ageing sweep also picks up
 * a market whose 24h window lost a trade since its last refresh.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../../fixtures/config');
const Utility           = require('../../../../../src/utility');
const Database          = require('../../../../../src/db');

const TOKEN_A = 5, TOKEN_B = 9, TOKEN_C = 12, COIN = 1;

function makeDb() {
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'db', 'u', 'p', { config: getTestConfig(), util });
    db.pool = { getConnection: sinon.stub().resolves({}) };
    sinon.stub(db, 'getBlockTime').resolves(1700000000);
    return db;
}

// Program the block-path reads: the order-family counts, the ORDER pair read, and the two
// order-state tables a non-ORDER action writes.
function blockReads(db, { counts = [], orders = [], statuses = [], coinpays = [] }) {
    sinon.stub(db, 'doQuery').callsFake(async (query) => {
        if (/count\(\*\) as count/.test(query)) return counts;
        if (/INNER JOIN order_statuses s1/.test(query)) return statuses;
        if (/INNER JOIN coinpay_statuses s1/.test(query)) return coinpays;
        if (/FROM\s+orders o1/.test(query)) return orders;
        return [];
    });
}

// A chain of 600 s blocks from height 1, so 24h is 144 blocks.
const T0 = 1600000000;
const timeOf = (h) => T0 + h * 600;
const cutoffAt = (h) => timeOf(h) - 86400;

// A Database whose blocks, statuses and markets answer the ageing reads. The block slice read
// returns one valid and one invalid match; only the valid one names market 3.
function agedDb(height) {
    const db = makeDb();
    let args = null;
    sinon.stub(db, 'protocolTimeForStoredBlock').callsFake(async (h) => timeOf(h));
    sinon.stub(db, 'getBlockTimeAtHeightOrNull').callsFake(async (h) => (h >= 1 && h <= height) ? timeOf(h) : null);
    sinon.stub(db, 'getStatusId').resolves(7);
    sinon.stub(db, 'getMarketRow').callsFake(async (t1, t2) => (Number(t1) === TOKEN_A && Number(t2) === TOKEN_B) ? { id: 3 } : { id: 4 });
    sinon.stub(db, 'doQuery').callsFake(async (query, a) => {
        if (/FROM markets\s+WHERE last_updated IS NULL/.test(query)) return [{ id: 1 }];
        if (/MIN\(block_index\)/.test(query)) return [{ b: 1 }];
        if (/INNER JOIN order_matches om/.test(query)) {
            args = a;
            return [{ give_tick_id: TOKEN_A, get_tick_id: TOKEN_B, status_id: 7 },
                    { give_tick_id: TOKEN_B, get_tick_id: TOKEN_C, status_id: 8 }];
        }
        if (/SELECT id FROM markets\s+WHERE id IN/.test(query)) return a.slice(0, -1).map(id => ({ id }));
        return [];
    });
    return { db, sliceArgs: () => args };
}

const pairKey = (p) => Math.min(p.tick1_id, p.tick2_id) + ':' + Math.max(p.tick1_id, p.tick2_id);

afterEach(function () { sinon.restore(); });

describe('markets: refresh on every order-state change @regression @tier1', function () {
    it('collects the pair a COINPAY settled in a block with no ORDER-family action', async function () {
        const db = makeDb();
        const pair = { action_index: 40, tick1_id: null, tick2_id: TOKEN_A, coin1_id: COIN, coin2_id: COIN };
        blockReads(db, { coinpays: [pair] });
        const markets = await db.getMarkets(8, false);
        assert.deepStrictEqual(markets.map(pairKey), [pairKey({ tick1_id: 0, tick2_id: TOKEN_A })]);
    });

    it('collects the pairs of the orders a SWEEP cancelled', async function () {
        const db = makeDb();
        blockReads(db, { statuses: [
            { action_index: 47, tick1_id: TOKEN_A, tick2_id: TOKEN_B, coin1_id: COIN, coin2_id: COIN },
            { action_index: 48, tick1_id: TOKEN_B, tick2_id: TOKEN_A, coin1_id: COIN, coin2_id: COIN },
        ] });
        const markets = await db.getMarkets(7, false);
        assert.deepStrictEqual(markets.map(pairKey), [pairKey({ tick1_id: TOKEN_A, tick2_id: TOKEN_B })]);
    });

    it('keeps the ORDER-family pairs first so new-pair id assignment order is unchanged', async function () {
        const db = makeDb();
        blockReads(db, {
            counts: [{ count: 1, type: 'ORDER' }],
            orders: [{ action_index: 50, tick1_id: TOKEN_B, tick2_id: TOKEN_C, coin1_id: COIN, coin2_id: COIN }],
            statuses: [
                { action_index: 20, tick1_id: TOKEN_A, tick2_id: TOKEN_B, coin1_id: COIN, coin2_id: COIN },
                { action_index: 50, tick1_id: TOKEN_B, tick2_id: TOKEN_C, coin1_id: COIN, coin2_id: COIN },
            ],
        });
        const markets = await db.getMarkets(9, false);
        assert.deepStrictEqual(markets.map(pairKey), ['9:12', '5:9']);
    });

});

describe('markets: 24h ageing and reorg refresh @regression @tier1', function () {
    it('has the reorg collector read the same order_statuses pairs the block path refreshes', function () {
        const readSql = require('../../../../../src/db/rollback/read_phase.js');
        const query = readSql.entityQueryForCoinpayTables('order_statuses');
        assert.ok(query, 'an orphaned order status must name its market pair');
        assert.match(query, /INNER JOIN orders o1 ON \(o1\.action_index=m\.order_action_index\)/);
    });

    it('has a reorg also recompute the markets an orphaned block refreshed', async function () {
        const db = makeDb();
        let args = null;
        sinon.stub(db, 'doQuery').callsFake(async (query, a) => {
            if (/FROM markets WHERE last_updated > \?/.test(query)) {
                args = a;
                return [{ tick1_id: TOKEN_B, tick2_id: TOKEN_A, coin1_id: COIN, coin2_id: COIN },
                        { tick1_id: TOKEN_B, tick2_id: TOKEN_C, coin1_id: COIN, coin2_id: COIN }];
            }
            return [];
        });
        const touched = [{ tick1_id: TOKEN_A, tick2_id: TOKEN_B, coin1_id: COIN, coin2_id: COIN }];
        const out = await db.withMarketsRefreshedAfter(touched, 1700000000);
        assert.deepStrictEqual(args, [1700000000]);
        assert.deepStrictEqual(out.map(pairKey), ['5:9', '9:12'], 'the touched pair first, the aged one once');
    });

    it('adds every market whose 24h window lost a trade this block to the ageing sweep', async function () {
        const { db, sliceArgs } = agedDb(200);
        const rows = await db.getStaleMarkets(String(cutoffAt(200)), 25, 200);
        assert.deepStrictEqual(rows.map(r => Number(r.id)), [1, 3], 'the aged market follows the stale batch once');
        // The window start moved from block 55's time to block 56's. The block range is found 3 h
        // (18 blocks of 600 s) outside both edges; the time filter keeps the exact slice.
        assert.deepStrictEqual(sliceArgs(), [55 - 18, 56 + 18, timeOf(55), timeOf(56)]);
    });

    it('reads the same slice width however much history lies below it', async function () {
        for (const height of [200, 2000, 20000]) {
            const { db, sliceArgs } = agedDb(height);
            await db.getAgedMarkets(height, cutoffAt(height));
            const [lo, hi, from, to] = sliceArgs();
            assert.strictEqual(hi - lo, 1 + 2 * 18, 'slice width at height ' + height);
            assert.deepStrictEqual([from, to], [timeOf(height - 145), timeOf(height - 144)]);
        }
    });

    it('finds a trade in a block stamped 7200 s ahead, the most a stamp may lead', async function () {
        // Block 43 is stamped 2 h ahead, so its time equals block 55's, 12 heights above it: past a
        // 6-block widening, inside the 3 h one. It carries the only trade on market 3.
        const height = 200, ahead = 43;
        const stamp = (h) => (h === ahead) ? timeOf(h) + 7200 : timeOf(h);
        const db = makeDb();
        sinon.stub(db, 'protocolTimeForStoredBlock').callsFake(async (h) => timeOf(h));
        sinon.stub(db, 'getBlockTimeAtHeightOrNull').callsFake(async (h) => (h >= 1 && h <= height) ? stamp(h) : null);
        sinon.stub(db, 'getStatusId').resolves(7);
        sinon.stub(db, 'getMarketRow').resolves({ id: 3 });
        sinon.stub(db, 'doQuery').callsFake(async (query, a) => {
            if (/MIN\(block_index\)/.test(query)) return [{ b: 1 }];
            if (/INNER JOIN order_matches om/.test(query)) {
                const [lo, hi, from, to] = a;
                const inSlice = ahead >= lo && ahead <= hi && stamp(ahead) >= from && stamp(ahead) <= to;
                return inSlice ? [{ give_tick_id: TOKEN_A, get_tick_id: TOKEN_B, status_id: 7 }] : [];
            }
            if (/SELECT id FROM markets\s+WHERE id IN/.test(query)) return a.slice(0, -1).map(id => ({ id }));
            return [];
        });
        const rows = await db.getAgedMarkets(height, cutoffAt(height));
        assert.deepStrictEqual(rows.map(r => Number(r.id)), [3], 'the ahead-stamped trade leaves the window this block');
    });

    it('returns only the stale batch when the caller passes no block', async function () {
        const { db, sliceArgs } = agedDb(200);
        const rows = await db.getStaleMarkets(String(cutoffAt(200)), 25);
        assert.deepStrictEqual(rows.map(r => Number(r.id)), [1]);
        assert.strictEqual(sliceArgs(), null);
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

// Utility loads coin config in its constructor from these env vars.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const { makeUtil, makeDb, makeCtx, FEE_DEST, BTC_PRICES } = require('./fee_quote.test/helpers/quote_ctx.js');

describe('native coin fee quote @regression @tier1', function () {

    describe('computeNativeFeeBand()', function () {
        it('values 0.5 XCHAIN @ $1.00 against DOGE @ $0.10 => 5.0 (min 4.75, max 5.5)', function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let b = util.computeNativeFeeBand('0.5', '1.00000000', '0.10000000', util.bcnum('0.95'), util.bcnum('1.10'));
            assert.strictEqual(util.bcformat(b.expectedNative, 8), '5.00000000');
            assert.strictEqual(util.bcformat(b.minAcceptable, 8), '4.75000000');
            assert.strictEqual(util.bcformat(b.maxAcceptable, 8), '5.50000000');
        });
    });

    describe('getFeeOraclePrices()', function () {
        it('returns both prices + the COIN/USD round number', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let r = await util.getFeeOraclePrices(makeDb({ prices: BTC_PRICES }), 'BTC', 100, 1000, 1800);
            assert.ok(!r.error, r.error);
            assert.strictEqual(util.bcformat(r.coinUsdPrice, 8), '50000.00000000');
            assert.strictEqual(util.bcformat(r.xchainUsdPrice, 8), '1.00000000');
            assert.strictEqual(r.oracleRound, 7);
        });

        it('errors when COIN/USD is missing or stale', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let r = await util.getFeeOraclePrices(makeDb({ prices: { 'XCHAIN/USD': '1.0' } }), 'BTC', 100, 1000, 1800);
            assert.ok(/BTC\/USD .*(missing or stale)/.test(r.error), r.error);
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    // Every time-sensitive decision in getFeeOraclePrices (flag-day gate, non-BTC
    // round selection, staleness) anchors on the SINGLE chain-derived refTime the caller passes.
    // There is no separate wall-clock anchor to disagree with it.
    describe('getFeeOraclePrices() single chain-time anchor', function () {
        const GATE = require('../../../src/protocol_changes.js').NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME;
        // DB stub that records the opts (selectByTime, blockTime) getLatestPrice was called with.
        function makeCapturingDb(){
            let seen = { opts: null };
            let db = {
                getLatestBlockIndex: async () => 100,
                getLatestPrice: async (pair, blockIndex, opts) => {
                    seen.opts = opts;
                    let p = { 'XCHAIN/USD': '1.00000000', 'DOGE/USD': '0.10000000' }[pair];
                    return p == null ? null : { price: p, roundNumber: 7, block_timestamp: 1000 };
                }
            };
            return { db, seen };
        }
        function mainnetUtil(){
            let util = makeUtil('DOGE', FEE_DEST);
            util.config['NETWORK'] = 'mainnet';
            return util;
        }

        it('refTime before the gate => INACTIVE, and selection/staleness use that same refTime', async function () {
            let util = mainnetUtil();
            let { db, seen } = makeCapturingDb();
            let r = await util.getFeeOraclePrices(db, 'DOGE', 100, GATE - 1000, 1800);
            assert.ok(!r.error, r.error);
            assert.strictEqual(seen.opts.selectByTime, false);
            assert.strictEqual(seen.opts.blockTime, GATE - 1000, 'one anchor drives gate and staleness');
        });

        it('refTime after the gate => ACTIVE (consensus caller, byte-identical)', async function () {
            let util = mainnetUtil();
            let { db, seen } = makeCapturingDb();
            // validateNativeCoinFee passes BLOCK_TIME as refTime and nothing else.
            await util.getFeeOraclePrices(db, 'DOGE', 100, GATE + 1000, 1800);
            assert.strictEqual(seen.opts.selectByTime, true, 'gate active past the flag-day');
            assert.strictEqual(seen.opts.blockTime, GATE + 1000);
        });

        it('takes no wall-clock override: a 6th argument cannot split the anchor', async function () {
            let util = mainnetUtil();
            let { db, seen } = makeCapturingDb();
            // A stale caller still threading the removed gateTime must not resurrect the split
            // anchor that removed: the gate follows refTime and ignores the extra arg.
            await util.getFeeOraclePrices(db, 'DOGE', 100, GATE + 1000, 1800, GATE - 1000);
            assert.strictEqual(seen.opts.selectByTime, true);
            assert.strictEqual(seen.opts.blockTime, GATE + 1000);
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    describe('_priceFeeQuote()', function () {
        it('prices 1.0 XCHAIN at the band midpoint (2000 sats) with band bounds', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
            let q = await ctx.priceFeeQuote.call(ctx, { blockIndex: 100 }, '1.00000000', undefined);
            assert.strictEqual(q.valid, true);
            assert.strictEqual(q.xchainFee, '1.00000000');
            assert.strictEqual(q.requiredFeeNative, '0.00002000');
            assert.strictEqual(q.requiredFeeSats, 2000);
            assert.strictEqual(q.minAcceptable, '0.00001900');
            assert.strictEqual(q.maxAcceptable, '0.00002200');
            assert.strictEqual(q.oracleRound, 7);
        });

        it('zero fee: valid with all-zero sizing and no oracle read', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            // No prices seeded: a zero fee must not need them.
            let { ctx } = makeCtx(util, makeDb());
            let q = await ctx.priceFeeQuote.call(ctx, {}, '0', undefined);
            assert.strictEqual(q.valid, true);
            assert.strictEqual(q.requiredFeeSats, 0);
            assert.strictEqual(q.requiredFeeNative, '0.00000000');
        });

        it('judges a proposed output: accepts at exactly min, rejects just below', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
            let ok = await ctx.priceFeeQuote.call(ctx, { blockIndex: 100 }, '1.0', 1900);
            assert.strictEqual(ok.valid, true);
            let bad = await ctx.priceFeeQuote.call(ctx, { blockIndex: 100 }, '1.0', 1899);
            assert.strictEqual(bad.valid, false);
            assert.ok(/too small/.test(bad.error), bad.error);
        });

        it('missing/stale price => valid:false with the price error', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: { 'XCHAIN/USD': '1.0' } }));
            let q = await ctx.priceFeeQuote.call(ctx, { blockIndex: 100 }, '1.0', undefined);
            assert.strictEqual(q.valid, false);
            assert.ok(/missing or stale/.test(q.error), q.error);
        });
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// test/unit/fee_quote.test/chain_time_anchoring.test.js
//
// The pre-flight quote anchored on the evaluated block's chain time, never the
// operator's wall clock, and the price-source disclosure getFeeSchedule() makes.

const assert = require('assert');

// Utility loads coin config in its constructor from these env vars.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Actions = require('../../../src/actions/index.js');
const { makeUtil, FEE_DEST } = require('./helpers/quote_ctx.js');

const GATE = require('../../../src/protocol_changes.js').NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME;

// Price store reproducing db.getLatestPrice's real selection + staleness semantics over
// an in-memory row set, so these cases exercise the interaction the live venue hit and
// not just an argument-passing stub. Rows: { pair, price, round, ts, refBlock }.
function makePriceDb(rows, { blockIndex = 100, blockTime = null } = {}){
    let seen = { opts: [] };
    let db = {
        getLatestBlockIndex: async () => blockIndex,
        getBlockTime:        async () => blockTime,
        getLatestPrice: async (pair, blockHeight, opts) => {
            seen.opts.push(opts);
            let eligible = rows.filter(r => r.pair === pair).filter(r =>
                (opts && opts.selectByTime)
                    ? r.ts <= Number(opts.blockTime)
                    : r.refBlock <= blockHeight);
            if(eligible.length === 0) return null;
            let row = eligible.sort((a, b) => b.round - a.round)[0];
            if(opts && parseInt(opts.maxAgeSeconds) > 0 &&
               (parseInt(opts.blockTime) - row.ts) > parseInt(opts.maxAgeSeconds))
                return null;
            return { price: row.price, roundNumber: row.round, block_timestamp: row.ts };
        }
    };
    return { db, seen };
}

// A chain whose clock runs ahead of real time (mock-time regtest, or any skewed venue):
// the newest rounds carry timestamps in the future relative to wall clock.
const AHEAD_TIP = GATE + 86400;
function dogeRows(tipTime){
    return [
        { pair: 'DOGE/USD',   price: '0.10000000', round: 9, ts: tipTime - 120, refBlock: 50 },
        { pair: 'XCHAIN/USD', price: '1.00000000', round: 9, ts: tipTime - 120, refBlock: 50 }
    ];
}

// Minimal Actions-like context for the pricing methods (no dry-run engine involved).
function ctxFor(util, db){
    return {
        config: util.config, util: util, indexerDb: db,
        nativeFeeMandatory: Actions.prototype.nativeFeeMandatory,
        priceFeeQuote:      Actions.prototype.priceFeeQuote
    };
}

// A regtest node reading prices through the hub database, beside a local store
// that holds different prices, so a case can tell which store was actually read.
function hubBacked(){
    let util = makeUtil('BTC', FEE_DEST);
    util.config['NETWORK'] = 'regtest';
    let tip = 1900000000;
    // Two stores holding DIFFERENT prices, so the assertion below proves which one
    // was actually read rather than merely that a number came back.
    let local = makePriceDb([
        { pair: 'BTC/USD',    price: '11111.00000000', round: 4, ts: tip, refBlock: 100 },
        { pair: 'XCHAIN/USD', price: '1.00000000',     round: 4, ts: tip, refBlock: 100 }
    ], { blockTime: tip });
    let hub = makePriceDb([
        { pair: 'BTC/USD',    price: '50000.00000000', round: 4, ts: tip, refBlock: 100 },
        { pair: 'XCHAIN/USD', price: '2.00000000',     round: 4, ts: tip, refBlock: 100 }
    ], { blockTime: tip });
    hub.db.dbName   = 'XChain_Hub';
    local.db.dbName = 'XChain_BTC_Regtest_Indexer';
    local.db.indexer = { hubDb: hub.db };
    let ctx = ctxFor(util, local.db);
    ctx.getFeeSchedule = Actions.prototype.getFeeSchedule;
    return { ctx, util };
}

describe('native coin fee quote @regression @tier1', function () {
    // the pre-flight exists to predict validateNativeCoinFee, which reads prices as of
    // the evaluated BLOCK's time. Anchoring the pre-flight on the operator's wall clock instead
    // made it disagree with the chain in both directions. These cases pin the anchor.
    describe('_priceFeeQuote() chain-time anchoring', function () {
        it('clock-ahead venue: a non-BTC quote reads the rounds the chain can see', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            util.config['NETWORK'] = 'mainnet';
            let { db, seen } = makePriceDb(dogeRows(AHEAD_TIP));
            let ctx = ctxFor(util, db);
            let q = await ctx.priceFeeQuote.call(ctx, { blockIndex: 100, blockTime: AHEAD_TIP }, '1.00000000', undefined);
            assert.ok(!q.error, q.error);
            assert.strictEqual(q.valid, true);
            assert.strictEqual(q.oracleRound, 9);
            assert.strictEqual(seen.opts[0].blockTime, AHEAD_TIP, 'anchored on the quoted block time');
            assert.strictEqual(seen.opts[0].selectByTime, true, 'past the flag-day, non-BTC selects by time');
        });

        it('clock-ahead venue: wall-clock anchoring would have excluded every round', async function () {
            // The pre- behaviour, reproduced by anchoring on a wall clock a day behind the
            // chain: `block_timestamp <= refTime` drops the future-stamped rounds outright, which
            // is what made LTC/DOGE feequote structurally dead on those venues.
            let util = makeUtil('DOGE', FEE_DEST);
            util.config['NETWORK'] = 'mainnet';
            let { db } = makePriceDb(dogeRows(AHEAD_TIP));
            let wallClock = AHEAD_TIP - 86400;
            let r = await util.getFeeOraclePrices(db, 'DOGE', 100, wallClock, 1800);
            assert.ok(/no current oracle price for DOGE\/USD/.test(r.error), 'expected the old dead-quote error');
            // Same store, same instant, anchored on chain time instead: a live round ~120s old.
            let ok = await util.getFeeOraclePrices(db, 'DOGE', 100, AHEAD_TIP, 1800);
            assert.ok(!ok.error, ok.error);
            assert.strictEqual(ok.oracleRound, 9);
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    describe('_priceFeeQuote() chain-time anchoring', function () {
        it('BTC block drought: a round stamped at the tip block is not called stale', async function () {
            // Rounds are stamped from reference-chain block times, so during a drought the newest
            // round ages against wall clock while the chain still prices off it. Tip block time is
            // the quantity consensus uses, and by it the round is fresh.
            let util = makeUtil('BTC', FEE_DEST);
            let tipTime = 1900000000;
            let { db, seen } = makePriceDb([
                { pair: 'BTC/USD',    price: '50000.00000000', round: 4, ts: tipTime, refBlock: 100 },
                { pair: 'XCHAIN/USD', price: '1.00000000',     round: 4, ts: tipTime, refBlock: 100 }
            ]);
            let ctx = ctxFor(util, db);
            let q = await ctx.priceFeeQuote.call(ctx, { blockIndex: 100, blockTime: tipTime }, '1.00000000', undefined);
            assert.strictEqual(q.valid, true, q.error);
            assert.strictEqual(q.requiredFeeSats, 2000);
            assert.strictEqual(seen.opts[0].blockTime, tipTime);
            // Anchored on a wall clock 2000s past the drought's last block, the same store reports
            // the pair stale: the false negative describes.
            let stale = await util.getFeeOraclePrices(db, 'BTC', 100, tipTime + 2000, 1800);
            assert.ok(/missing or stale/.test(stale.error), stale.error);
        });

        it('falls back to wall clock only when the quote carries no block time', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let nowEpoch = Math.floor(Date.now() / 1000);
            let { db, seen } = makePriceDb([
                { pair: 'BTC/USD',    price: '50000.00000000', round: 4, ts: nowEpoch - 60, refBlock: 100 },
                { pair: 'XCHAIN/USD', price: '1.00000000',     round: 4, ts: nowEpoch - 60, refBlock: 100 }
            ]);
            let ctx = ctxFor(util, db);
            let q = await ctx.priceFeeQuote.call(ctx, { blockIndex: 100 }, '1.00000000', undefined);
            assert.strictEqual(q.valid, true, q.error);
            assert.ok(Math.abs(seen.opts[0].blockTime - nowEpoch) <= 5, 'wall-clock fallback, got ' + seen.opts[0].blockTime);
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    describe('_priceFeeQuote() chain-time anchoring', function () {
        it('getFeeSchedule() prices off the tip block time too, and reports it', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            util.config['NETWORK'] = 'mainnet';
            let { db, seen } = makePriceDb(dogeRows(AHEAD_TIP), { blockTime: AHEAD_TIP });
            let ctx = ctxFor(util, db);
            ctx.getFeeSchedule = Actions.prototype.getFeeSchedule;
            let s = await ctx.getFeeSchedule.call(ctx);
            assert.strictEqual(s.blockTime, AHEAD_TIP);
            assert.strictEqual(seen.opts[0].blockTime, AHEAD_TIP);
            assert.strictEqual(s.prices.available, true, s.prices.error);
            assert.strictEqual(s.prices.oracleRound, 9);
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    describe('_priceFeeQuote() chain-time anchoring', function () {
        // Which database the prices came out of is invisible from outside the process and is
        // decided by one env var (HUB_DB_NAME) on the indexer alone. Anything off-box that
        // SEEDS prices has to write into that same database, and when it guesses wrong the
        // only symptom is every priced action failing `no current oracle price` with both
        // databases healthy. These pin the disclosure to the read it describes.
        describe('getFeeSchedule() discloses where it read the prices', function () {
            it('names the indexer\'s own database on a single-host node', async function () {
                let util = makeUtil('BTC', FEE_DEST);
                util.config['NETWORK'] = 'regtest';
                let tip = 1900000000;
                let { db } = makePriceDb([
                    { pair: 'BTC/USD',    price: '50000.00000000', round: 4, ts: tip, refBlock: 100 },
                    { pair: 'XCHAIN/USD', price: '1.00000000',     round: 4, ts: tip, refBlock: 100 }
                ], { blockTime: tip });
                db.dbName = 'XChain_BTC_Regtest_Indexer';
                let ctx = ctxFor(util, db);
                ctx.getFeeSchedule = Actions.prototype.getFeeSchedule;
                let s = await ctx.getFeeSchedule.call(ctx);
                assert.strictEqual(s.priceSource.hubDb, false);
                assert.strictEqual(s.priceSource.database, 'XChain_BTC_Regtest_Indexer');
            });

            it('names the hub database, and it is the one the price actually came from', async function () {
                let { ctx } = hubBacked();
                let s = await ctx.getFeeSchedule.call(ctx);
                assert.strictEqual(s.priceSource.hubDb, true);
                assert.strictEqual(s.priceSource.database, 'XChain_Hub');
                assert.strictEqual(s.prices.available, true, s.prices.error);
                assert.strictEqual(s.prices.coinUsd, '50000.00000000', 'read the hub store, not the local one');
            });

            // Public read surface: the boolean is the client's business, the internal
            // database name is not.
            it('withholds the database name on mainnet but still reports the boolean', async function () {
                let { ctx, util } = hubBacked();
                util.config['NETWORK'] = 'mainnet';
                let s = await ctx.getFeeSchedule.call(ctx);
                assert.strictEqual(s.priceSource.hubDb, true);
                assert.strictEqual(s.priceSource.database, null);
            });
        });
    });
});

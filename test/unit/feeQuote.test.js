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

const Utility   = require('../../src/utility.js');
const Actions   = require('../../src/actions.js');
const Issue     = require('../../src/actions/issue.js');
const Order     = require('../../src/actions/order.js');
const Swap      = require('../../src/actions/swap.js');
const Dispenser = require('../../src/actions/dispenser.js');

const FEE_DEST    = 'feeDestinationAddr111111111111111';
const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

// Utility with a known fee destination, tolerance band, gas schedule + price.
function makeUtil(coin, feeDestination){
    let util = new Utility();
    util.config['COIN']                         = coin;
    util.config['ADDRESS']                      = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: feeDestination });
    util.config['FEE_TOLERANCE_MIN']            = '0.95';
    util.config['FEE_TOLERANCE_MAX']            = '1.10';
    util.config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;
    util.config['GAS_PRICE']                    = '0.00001';
    util.config['GAS_SCHEDULE']                 = { ISSUE: 100000, ISSUE_SUBTOKEN: 10000, EXPIRATION_PER_DAY: 10, OWNERSHIP_ESCROW: 5000 };
    util.config['UNIFIED_EXPIRATION_FEE_FREE_DAYS'] = 90;
    return util;
}

// Indexer DB stub. getLatestPrice ignores the staleness opts (mirrors nativeCoinFee.test.js) —
// a pair set to null models a missing/stale price.
function makeDb({ tokenExists = false, prices = {}, blockIndex = 100, blockTime = 1000 } = {}){
    return {
        getLatestBlockIndex: async () => blockIndex,
        getBlockTime:        async () => blockTime,
        getTokenInfo:        async () => tokenExists ? { TICK: 'X', TICK_ID: 1, OWNER: 'src' } : null,
        getLatestPrice:      async (pair) => {
            if(prices[pair] == null) return null;
            return { price: prices[pair], roundNumber: 7, block_timestamp: 1000 };
        }
    };
}

// Minimal Actions-like context: real per-handler `formats` + the real prototype methods under test.
function makeActions(util, indexerDb, enabled){
    let parent = { config: util.config, util, decoderDb: null, indexerDb, mapper: null };
    return {
        config:          util.config,
        util:            util,
        indexerDb:       indexerDb,
        protocolChanges: { isEnabled: async (name) => !!enabled[name] },
        actionIssue:     new Issue(parent),
        actionOrder:     new Order(parent),
        actionSwap:      new Swap(parent),
        actionDispenser: new Dispenser(parent),
        estimateActionFee: Actions.prototype.estimateActionFee,
        computeFeeQuote:   Actions.prototype.computeFeeQuote
    };
}

const ALL_ON = { ISSUANCE_FEE: true, UNIFIED_FEES: true };
// 1.0 XCHAIN @ $1.00, BTC @ $50,000 => 0.00002 BTC (2000 sats); min 0.000019 (1900), max 0.000022 (2200).
const BTC_PRICES = { 'XCHAIN/USD': '1.00000000', 'BTC/USD': '50000.00000000' };

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

    describe('estimateActionFee() parity', function () {
        it('ISSUE create (new token) charges schedule.ISSUE * GAS_PRICE under unified fees', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let actions = makeActions(util, makeDb(), ALL_ON);
            let data = { ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: null };
            let r = await actions.estimateActionFee(data, ['0', 'NEWTICK']);
            assert.strictEqual(r.supported, true);
            // 100000 * 0.00001 = 1.0 XCHAIN
            assert.strictEqual(util.bcformat(r.amount, 8), '1.00000000');
        });

        it('ISSUE of an already-existing token charges no issuance fee', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let actions = makeActions(util, makeDb({ tokenExists: true }), ALL_ON);
            let r = await actions.estimateActionFee({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: null }, ['0', 'EXISTS']);
            assert.strictEqual(r.supported, true);
            assert.strictEqual(util.bcformat(r.amount, 8), '0.00000000');
        });

        it('ORDER create with a far expiration charges the unified expiration fee', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let actions = makeActions(util, makeDb({ blockTime: 1000 }), ALL_ON);
            // EXPIRATION = blockTime + 200 days; chargeable = 200-90 = 110 days; 110*10*0.00001 = 0.011
            let exp = String(1000 + 200 * 86400);
            let data = { ACTION: 'ORDER', FORMAT: 0, BLOCK_INDEX: 100, BLOCK_TIME: 1000, ACTION_INDEX: null };
            let params = ['0', 'BTC', 'FOO', '100', '0', 'BTC', 'BAR', '1', '0', 'addr', exp];
            let r = await actions.estimateActionFee(data, params);
            assert.strictEqual(r.supported, true);
            assert.strictEqual(util.bcformat(r.amount, 8), '0.01100000');
        });

        it('unsupported actions (SEND, ISSUE edit) report supported:false', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let actions = makeActions(util, makeDb(), ALL_ON);
            let send = await actions.estimateActionFee({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100 }, ['0', 'FOO', '1', 'dest']);
            assert.strictEqual(send.supported, false);
            let edit = await actions.estimateActionFee({ ACTION: 'ISSUE', FORMAT: 2, BLOCK_INDEX: 100, ACTION_INDEX: null }, ['2', 'FOO']);
            assert.strictEqual(edit.supported, false);
        });
    });

    describe('computeFeeQuote()', function () {
        it('ISSUE create: returns the native fee + sats sized to the band midpoint', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let actions = makeActions(util, makeDb({ prices: BTC_PRICES }), ALL_ON);
            let q = await actions.computeFeeQuote({ action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src' });
            assert.strictEqual(q.supported, true);
            assert.strictEqual(q.valid, true);
            assert.strictEqual(q.xchainFee, '1.00000000');
            assert.strictEqual(q.requiredFeeNative, '0.00002000');
            assert.strictEqual(q.requiredFeeSats, 2000);
            assert.strictEqual(q.minAcceptable, '0.00001900');
            assert.strictEqual(q.oracleRound, 7);
            assert.strictEqual(q.feeDestination, FEE_DEST);
        });

        it('accepts a proposed output at exactly the min, rejects just below', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let actions = makeActions(util, makeDb({ prices: BTC_PRICES }), ALL_ON);
            let ok = await actions.computeFeeQuote({ action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src', feeOutputSats: 1900 });
            assert.strictEqual(ok.valid, true);
            let bad = await actions.computeFeeQuote({ action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src', feeOutputSats: 1899 });
            assert.strictEqual(bad.valid, false);
            assert.ok(/too small/.test(bad.error), bad.error);
        });

        it('ISSUE of an existing token: zero fee, valid, no native output required', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let actions = makeActions(util, makeDb({ tokenExists: true, prices: BTC_PRICES }), ALL_ON);
            let q = await actions.computeFeeQuote({ action: 'ISSUE', params: ['0', 'EXISTS'], source: 'src' });
            assert.strictEqual(q.valid, true);
            assert.strictEqual(q.xchainFee, '0.00000000');
            assert.strictEqual(q.requiredFeeSats, 0);
        });

        it('invalid (stale/missing price) => valid:false with the price error', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let actions = makeActions(util, makeDb({ prices: { 'XCHAIN/USD': '1.0' } }), ALL_ON);
            let q = await actions.computeFeeQuote({ action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src' });
            assert.strictEqual(q.valid, false);
            assert.ok(/missing or stale/.test(q.error), q.error);
        });

        it('unsupported action => supported:false (client pays in XCHAIN)', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let actions = makeActions(util, makeDb({ prices: BTC_PRICES }), ALL_ON);
            let q = await actions.computeFeeQuote({ action: 'SEND', params: ['0', 'FOO', '1', 'dest'], source: 'src' });
            assert.strictEqual(q.supported, false);
            assert.strictEqual(q.valid, false);
        });

        it('no FEE_DESTINATION configured => supported:false', async function () {
            let util = makeUtil('BTC', PLACEHOLDER);
            let actions = makeActions(util, makeDb({ prices: BTC_PRICES }), ALL_ON);
            let q = await actions.computeFeeQuote({ action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src' });
            assert.strictEqual(q.supported, false);
            assert.ok(/not enabled/.test(q.error), q.error);
        });

        it('accepts a string params payload (pipe-delimited)', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let actions = makeActions(util, makeDb({ prices: BTC_PRICES }), ALL_ON);
            let q = await actions.computeFeeQuote({ action: 'ISSUE', params: '0|NEWTICK', source: 'src' });
            assert.strictEqual(q.requiredFeeSats, 2000);
        });
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Order_Match native coin matches: pending_coinpay settlement, the native
// reciprocity gate on both sides of its flag day, and GET_TICK-null routing
// rejected as mis-paired.
// Part of the Order_Match suite; see ../order_match.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const {
    BLOCK_TIME, makeOrderInfo, makeMatchInfo, useOrderMatchHarness,
} = require('./helpers/order_match_harness.js');

// Each test gets a fresh harness from useOrderMatchHarness; bind() hands it to
// the names the test bodies use.
let indexer, actionsCtx, orderMatch;
const bind = (h) => { ({ indexer, actionsCtx, orderMatch } = h); };

// ─── Native coin match (pending_coinpay settlement) ───────────────────

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('native coin GIVE_TICK on orderInfo → pending_coinpay status, createCoinpayObligation called', async function () {
        // orderInfo is offering native coin (null GIVE_TICK), matchInfo has PEPECASH
        const nativeOrderInfo = makeOrderInfo({
            GIVE_TICK:      null,  // native coin side
            GIVE_REMAINING: '0.001',
            GET_TICK:       'PEPECASH',
            GET_REMAINING:  '100',
            GIVE_PRICE:     '100000',  // 1 PEPECASH per 0.00001 BTC → high ratio
            GET_PRICE:      '0.00001',
            SOURCE:         'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        });
        const nativeMatchInfo = makeMatchInfo({
            GIVE_TICK:      'PEPECASH',
            GIVE_REMAINING: '100',
            GET_TICK:       null,   // native coin side
            GET_REMAINING:  '0.001',
            GET_PRICE:      '100000',
            GET_ADDRESS:    'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        });

        indexer.indexerDb.getOrderInfo.resolves(nativeOrderInfo);
        indexer.indexerDb.findOrderMatches.resolves([nativeMatchInfo]);
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any).resolves(null)
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, ALLOW_LIST: null, BLOCK_LIST: null }));

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createCoinpayObligation);
        sinon.assert.calledOnce(indexer.indexerDb.createCoinpayStatus);
        // Instant status set to pending_coinpay
        assert.strictEqual(data['STATUS'], 'pending_coinpay');
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('native coin GET_TICK on orderInfo → pending_coinpay, matchInfo is coin payer', async function () {
        // orderInfo wants native coin (null GET_TICK), matchInfo provides it (null GIVE_TICK)
        const orderWithNullGet = makeOrderInfo({
            GIVE_TICK:      'RAREPEPE',
            GIVE_REMAINING: '10',
            GET_TICK:       null,  // wants native coin
            GET_REMAINING:  '0.001',
            GIVE_PRICE:     '0.0001',
            GET_PRICE:      '10000',
            SOURCE:         'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            GET_ADDRESS:    'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        });
        const matchWithNullGive = makeMatchInfo({
            GIVE_TICK:      null,  // offering native coin
            GIVE_REMAINING: '0.001',
            GET_TICK:       'RAREPEPE',
            GET_REMAINING:  '10',
            GET_PRICE:      '0.0001',
            SOURCE:         'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            GET_ADDRESS:    'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        });

        indexer.indexerDb.getOrderInfo.resolves(orderWithNullGet);
        indexer.indexerDb.findOrderMatches.resolves([matchWithNullGive]);
        indexer.indexerDb.getTokenInfo.resolves(null); // both ticks are native

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createCoinpayObligation);
    });
});

// findOrderMatches NULL-relaxes the reverse leg, so a token-for-COIN order
// (GET_TICK null) can pair with a token-for-token maker whose GIVE_TICK is a real token.
// That is not a coin trade (no side gives native coin against the coin-wanting side), and
// settling it would mint a bogus COINPay obligation and mis-assign the coin/seller roles.
// With COINPAY_NATIVE_RECIPROCITY active the reciprocity gate must skip it.
describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('skips a native match whose reverse leg is a real token, not native coin (, flag ON)', async function () {
        indexer.indexerDb.getTokenInfo
            .withArgs('SCAMTOKEN', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'SCAMTOKEN', TICK_ID: 30, ALLOW_LIST: null, BLOCK_LIST: null }));

        // orderInfo: GIVE RAREPEPE, GET native coin (GET_TICK null).
        const orderWantsCoin = makeOrderInfo({
            GIVE_TICK:      'RAREPEPE',
            GIVE_REMAINING: '10',
            GET_TICK:       null,      // wants native coin
            GET_REMAINING:  '0.001',
            GIVE_PRICE:     '0.0001',
            GET_PRICE:      '10000',
        });
        // matchInfo: GETs RAREPEPE (forward leg holds) but GIVES a REAL token, not native coin
        // (reverse leg violated - the NULL relaxation is what let this through findOrderMatches).
        const tokenMaker = makeMatchInfo({
            GIVE_TICK:      'SCAMTOKEN',   // a real token, NOT native coin
            GIVE_REMAINING: '100',
            GET_TICK:       'RAREPEPE',
            GET_REMAINING:  '10',
            GET_PRICE:      '0.0001',
        });

        indexer.indexerDb.getOrderInfo.resolves(orderWantsCoin);
        indexer.indexerDb.findOrderMatches.resolves([tokenMaker]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createCoinpayObligation);
        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('LEGACY (flag OFF): the mis-paired native match still settles (pre-flag-day replay parity)', async function () {
        actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(false);

        indexer.indexerDb.getTokenInfo
            .withArgs('SCAMTOKEN', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'SCAMTOKEN', TICK_ID: 30, ALLOW_LIST: null, BLOCK_LIST: null }));

        const orderWantsCoin = makeOrderInfo({
            GIVE_TICK:      'RAREPEPE',
            GIVE_REMAINING: '10',
            GET_TICK:       null,
            GET_REMAINING:  '0.001',
            GIVE_PRICE:     '0.0001',
            GET_PRICE:      '10000',
        });
        const tokenMaker = makeMatchInfo({
            GIVE_TICK:      'SCAMTOKEN',
            GIVE_REMAINING: '100',
            GET_TICK:       'RAREPEPE',
            GET_REMAINING:  '10',
            GET_PRICE:      '0.0001',
        });

        indexer.indexerDb.getOrderInfo.resolves(orderWantsCoin);
        indexer.indexerDb.findOrderMatches.resolves([tokenMaker]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
        await orderMatch.parse([], data, false);

        // Below the flag-day the legacy behaviour (bogus obligation) is preserved byte-for-byte.
        sinon.assert.calledOnce(indexer.indexerDb.createCoinpayObligation);
    });
});

// ─── GET_TICK null routing (native coin, lines 258-270) ──────────────────

// The GET_TICK-null routing branches (order_match native cases 3/4) only ever fire
// for a MIS-PAIRED match - one side has a null GET_TICK (wants native coin) while the
// counterparty's GIVE_TICK is a real token, so no side actually gives native coin against
// the coin-wanting side. findOrderMatches' NULL-relaxed reverse leg lets the first shape
// through; the second is not even reachable (its forward leg fails). With
// COINPAY_NATIVE_RECIPROCITY active the reciprocity gate rejects both, so no bogus COINPay
// obligation is minted and the coin/seller roles are never mis-assigned downstream.
describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    describe('native coin routing via GET_TICK null is rejected as mis-paired', function () {
        it('orderInfo GET_TICK null but matchInfo GIVES a real token (not coin) → skipped, no obligation', async function () {
            const orderWantsNative = makeOrderInfo({
                GIVE_TICK:      'RAREPEPE',
                GIVE_REMAINING: '10',
                GET_TICK:       null,     // wants native coin
                GET_REMAINING:  '0.001',
                GIVE_PRICE:     '0.0001',
                GET_PRICE:      '10000',
                GET_ADDRESS:    'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            });
            const matchPaysNative = makeMatchInfo({
                GIVE_TICK:      'PEPECASH', // a real token, NOT native coin : the mis-pair
                GIVE_REMAINING: '100',
                GET_TICK:       'RAREPEPE',
                GET_REMAINING:  '10',
                GET_PRICE:      '0.0001',
                GET_ADDRESS:    'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });

            indexer.indexerDb.getOrderInfo.resolves(orderWantsNative);
            indexer.indexerDb.findOrderMatches.resolves([matchPaysNative]);
            indexer.indexerDb.getTokenInfo
                .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
                .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
            indexer.indexerDb.getTokenInfo
                .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
                .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, ALLOW_LIST: null, BLOCK_LIST: null }));

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
            await orderMatch.parse([], data, false);

            sinon.assert.notCalled(indexer.indexerDb.createCoinpayObligation);
            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    describe('native coin routing via GET_TICK null is rejected as mis-paired', function () {
        it('matchInfo GET_TICK null against a token-for-token order (unreachable forward leg) → skipped', async function () {
            const orderPaysCoin = makeOrderInfo({
                GIVE_TICK:      'PEPECASH',
                GIVE_REMAINING: '100',
                GET_TICK:       'RAREPEPE', // non-null : a token-for-token order
                GET_REMAINING:  '10',
                GIVE_PRICE:     '10',
                GET_PRICE:      '0.1',
                GET_ADDRESS:    'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            });
            const matchWantsNative = makeMatchInfo({
                GIVE_TICK:      'RAREPEPE', // non-null GIVE_TICK
                GIVE_REMAINING: '10',
                GET_TICK:       null,        // matchInfo wants native coin : forward leg cannot mirror
                GET_REMAINING:  '100',
                GET_PRICE:      '10',
                GET_ADDRESS:    'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });

            indexer.indexerDb.getOrderInfo.resolves(orderPaysCoin);
            indexer.indexerDb.findOrderMatches.resolves([matchWantsNative]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
            await orderMatch.parse([], data, false);

            sinon.assert.notCalled(indexer.indexerDb.createCoinpayObligation);
            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });

    });
});

'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const { stubGate } = require('../../../../helpers/gate_modules.js');
const OrderMatch = require('../../../../../src/actions/order_match/index.js');
const SwapMatch = require('../../../../../src/actions/swap_match/index.js');

const GATE = 'same_token_offer_refusal_activation.SAME_TOKEN_OFFER_REFUSAL_ACTIVATION';

function makeActions(indexer){
    return {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function orderInfo(sameToken, overrides = {}){
    return {
        ACTION_INDEX: 1,
        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_COIN: 'BTC', GIVE_TICK: sameToken ? 'TOKEN' : 'GIVE', GIVE_AMOUNT: '10', GIVE_REMAINING: '10',
        GET_COIN: 'BTC', GET_TICK: sameToken ? 'TOKEN' : 'GET', GET_AMOUNT: '10', GET_REMAINING: '10',
        GET_ADDRESS: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_PRICE: '1', GET_PRICE: '1', ALLOW_LIST: null, BLOCK_LIST: null, ORDER_STATUS: 'open',
        ...overrides,
    };
}

function orderCandidate(sameToken){
    return orderInfo(sameToken, {
        ACTION_INDEX: 2,
        SOURCE: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        GIVE_TICK: sameToken ? 'TOKEN' : 'GET',
        GET_TICK: sameToken ? 'TOKEN' : 'GIVE',
        GET_ADDRESS: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
    });
}

function swapInfo(sameToken, overrides = {}){
    return {
        ACTION_INDEX: 10,
        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        SWAP_STATUS: 'open',
        GIVE_COIN: 'BTC', GIVE_TICK: sameToken ? 'TOKEN' : 'GIVE', GIVE_AMOUNT: '10',
        GET_COIN: 'BTC', GET_TICK: sameToken ? 'TOKEN' : 'GET', GET_AMOUNT: '5',
        GET_ADDRESS: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        ALLOW_LIST: null, BLOCK_LIST: null,
        ...overrides,
    };
}

function swapCandidate(sameToken){
    return swapInfo(sameToken, {
        ACTION_INDEX: 20,
        SOURCE: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        GIVE_TICK: sameToken ? 'TOKEN' : 'GET', GIVE_AMOUNT: '5',
        GET_TICK: sameToken ? 'TOKEN' : 'GIVE', GET_AMOUNT: '10',
        GET_ADDRESS: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
    });
}

function setTokenLookup(indexer){
    indexer.indexerDb.getTokenInfo.callsFake(async (tick) => {
        const key = String(tick).toLowerCase();
        if(['token', '^10'].includes(key))
            return createTokenInfo({ TICK: 'TOKEN', TICK_ID: 10, DECIMALS: 0 });
        if(key === 'give')
            return createTokenInfo({ TICK: 'GIVE', TICK_ID: 11, DECIMALS: 0 });
        if(key === 'get')
            return createTokenInfo({ TICK: 'GET', TICK_ID: 12, DECIMALS: 0 });
        return null;
    });
}

async function runOrderMatch(sameToken, blockIndex){
    const indexer = createMockIndexer();
    setTokenLookup(indexer);
    indexer.indexerDb.getOrderInfo.resolves(orderInfo(sameToken));
    indexer.indexerDb.findOrderMatches.resolves([orderCandidate(sameToken)]);
    indexer.indexerDb.createActionIndex.resolves(999);
    const handler = new OrderMatch(makeActions(indexer));
    await handler.parse(null, createBaseData({ ACTION: 'ORDER_MATCH', ACTION_INDEX: 1, BLOCK_INDEX: blockIndex }), null);
    return indexer;
}

async function runSwapMatch(sameToken, blockIndex){
    const indexer = createMockIndexer();
    setTokenLookup(indexer);
    indexer.indexerDb.getSwapInfo.resolves(swapInfo(sameToken));
    indexer.indexerDb.findSwapMatches.resolves([swapCandidate(sameToken)]);
    indexer.indexerDb.createActionIndex.resolves(999);
    const handler = new SwapMatch(makeActions(indexer));
    await handler.parse(null, createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: blockIndex }), null);
    return indexer;
}

describe('same-token offer match refusal @regression @tier1', function () {
    beforeEach(function () {
        stubGate(sinon, GATE, false).callsFake((_key, _network, _coin, height) => Number(height) >= 100);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('matches a pre-activation same-token ORDER but skips it at activation before escrow', async function () {
        const below = await runOrderMatch(true, 99);
        sinon.assert.calledOnce(below.indexerDb.createOrderMatch);
        sinon.assert.called(below.indexerDb.createEscrow);

        const active = await runOrderMatch(true, 100);
        sinon.assert.notCalled(active.indexerDb.createOrderMatch);
        sinon.assert.notCalled(active.indexerDb.createEscrow);
        sinon.assert.notCalled(active.indexerDb.createActionIndex);
    });

    it('matches a pre-activation same-token SWAP but skips it at activation before escrow', async function () {
        const below = await runSwapMatch(true, 99);
        sinon.assert.calledOnce(below.indexerDb.createSwapMatch);
        sinon.assert.called(below.indexerDb.createEscrow);

        const active = await runSwapMatch(true, 100);
        sinon.assert.notCalled(active.indexerDb.createSwapMatch);
        sinon.assert.notCalled(active.indexerDb.createEscrow);
        sinon.assert.notCalled(active.indexerDb.createActionIndex);
    });

    it('keeps different-token ORDER and SWAP matching unchanged on both sides of activation', async function () {
        for(const height of [99, 100]){
            const order = await runOrderMatch(false, height);
            sinon.assert.calledOnce(order.indexerDb.createOrderMatch);
            const swap = await runSwapMatch(false, height);
            sinon.assert.calledOnce(swap.indexerDb.createSwapMatch);
        }
    });

    it('leaves no match or escrow row after stored aliases canonicalize to one token', async function () {
        const order = await runOrderMatch(true, 100);
        const swap = await runSwapMatch(true, 100);
        assert.strictEqual(order.indexerDb.createOrderMatch.callCount + swap.indexerDb.createSwapMatch.callCount, 0);
        assert.strictEqual(order.indexerDb.createEscrow.callCount + swap.indexerDb.createEscrow.callCount, 0);
    });
});

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
const { OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, makeOrderContext } =
    require('../order.test/helpers/order_context.js');
const Swap = require('../../../../../src/actions/swap/index.js');

const GATE = 'same_token_offer_refusal_activation.SAME_TOKEN_OFFER_REFUSAL_ACTIVATION';
const VERDICT = 'invalid: cannot trade a token for itself';

function tokenInfo(tick){
    const key = String(tick).toLowerCase();
    if(['token', '^10'].includes(key))
        return createTokenInfo({ TICK: 'TOKEN', TICK_ID: 10, DECIMALS: 0 });
    if(key === 'other')
        return createTokenInfo({ TICK: 'OTHER', TICK_ID: 20, DECIMALS: 0 });
    return null;
}

function useResolvedTokens(indexer){
    indexer.indexerDb.getTokenInfo.resetBehavior();
    indexer.indexerDb.getTokenInfo.callsFake(async (tick) => tokenInfo(tick));
    indexer.indexerDb.getAddressBalances.resolves({ 10: '1000', 20: '1000', 99: '1000' });
}

async function runOrder(giveTick, getTick, blockIndex){
    const { indexer, order } = makeOrderContext();
    useResolvedTokens(indexer);
    const params = makeParams(`0|BTC|${giveTick}|10||BTC|${getTick}|5||${OWNER_ADDR}|${EXPIRATION}|||`);
    const data = createBaseData({
        ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_INDEX: blockIndex,
        BLOCK_TIME, COIN: 'BTC',
    });
    await order.parse(params, data, false);
    return { data, indexer };
}

function makeSwapContext(){
    const indexer = createMockIndexer();
    const actions = {
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
    useResolvedTokens(indexer);
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getTickerId.resolves(99);
    return { indexer, swap: new Swap(actions) };
}

async function runSwap(giveTick, getTick, blockIndex){
    const { indexer, swap } = makeSwapContext();
    const params = ['0', 'BTC', giveTick, '10', '', 'BTC', getTick, '5', '', '', String(EXPIRATION), '', '', ''];
    const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_INDEX: blockIndex, BLOCK_TIME });
    await swap.parse(params, data, null);
    return { data, indexer };
}

describe('same-token offer creation refusal @regression @tier1', function () {
    beforeEach(function () {
        stubGate(sinon, GATE, false).callsFake((_key, _network, _coin, height) => Number(height) >= 100);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('keeps a same-token ORDER valid below activation and refuses it at and above activation', async function () {
        assert.strictEqual((await runOrder('TOKEN', 'TOKEN', 99)).data['STATUS'], 'valid');
        assert.strictEqual((await runOrder('TOKEN', 'TOKEN', 100)).data['STATUS'], VERDICT);
        assert.strictEqual((await runOrder('TOKEN', 'TOKEN', 101)).data['STATUS'], VERDICT);
    });

    it('keeps a same-token SWAP valid below activation and refuses it at and above activation', async function () {
        assert.strictEqual((await runSwap('TOKEN', 'TOKEN', 99)).data['STATUS'], 'valid');
        assert.strictEqual((await runSwap('TOKEN', 'TOKEN', 100)).data['STATUS'], VERDICT);
        assert.strictEqual((await runSwap('TOKEN', 'TOKEN', 101)).data['STATUS'], VERDICT);
    });

    it('refuses an ORDER whose differently cased tick spellings resolve to one token id', async function () {
        assert.strictEqual((await runOrder('TOKEN', 'token', 100)).data['STATUS'], VERDICT);
    });

    it('refuses a SWAP whose name and caret alias resolve to one token id', async function () {
        assert.strictEqual((await runSwap('TOKEN', '^10', 100)).data['STATUS'], VERDICT);
    });

    it('keeps different-token ORDER and SWAP creation valid on both sides of activation', async function () {
        for(const height of [99, 100]){
            assert.strictEqual((await runOrder('TOKEN', 'OTHER', height)).data['STATUS'], 'valid');
            assert.strictEqual((await runSwap('TOKEN', 'OTHER', height)).data['STATUS'], 'valid');
        }
    });
});

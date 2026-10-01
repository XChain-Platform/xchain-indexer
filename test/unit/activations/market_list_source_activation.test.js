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
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const Database = require('../../../src/db');
const gateRegistry = require('../../../src/consensus/gate_registry');
const Order_Match = require('../../../src/actions/order_match/index.js');
const Swap_Match = require('../../../src/actions/swap_match/index.js');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const { stubGate } = require('../../helpers/gate_modules.js');

const KEY = 'market_list_source_activation.MARKET_LIST_SOURCE_ACTIVATION';
const LIST_ID = 901;
const BLOCKED_SOURCE = 'mvCounterpartySource1111111111111111';
const CLEAN_GET_ADDRESS = 'mwCleanPayoutAddress11111111111111111';

function useRealListLookup(indexer) {
    const db = indexer.indexerDb;
    db.config = indexer.config;
    db.util = indexer.util;
    db.getList = Database.prototype.getList;
    db.getListType = Database.prototype.getListType;
    db.doQuery.callsFake(async (query, args) => {
        if (/SELECT type FROM lists/.test(query))
            return Number(args[0]) === LIST_ID ? [{ type: 2 }] : [];
        if (/FROM\s+list_items/.test(query))
            return Number(args[0]) === LIST_ID ? [{ item: BLOCKED_SOURCE }] : [];
        throw new Error('unexpected list query: ' + query);
    });
}

function actionsFor(indexer) {
    return {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        processAction: sinon.stub().resolves(),
    };
}

function orderInfo() {
    return {
        ACTION_INDEX: 1,
        SOURCE: 'mrOrderSource11111111111111111111111',
        GIVE_COIN: 'BTC', GIVE_TICK: 'GIVE', GIVE_REMAINING: '10',
        GET_COIN: 'BTC', GET_TICK: 'GET', GET_REMAINING: '5',
        GIVE_PRICE: '0.5', GET_PRICE: '2',
        GET_ADDRESS: 'mxOrderPayout111111111111111111111',
        ALLOW_LIST: null, BLOCK_LIST: LIST_ID,
        ORDER_STATUS: 'open',
    };
}

function orderCounterparty() {
    return {
        ACTION_INDEX: 2,
        SOURCE: BLOCKED_SOURCE,
        GIVE_COIN: 'BTC', GIVE_TICK: 'GET', GIVE_REMAINING: '5',
        GET_COIN: 'BTC', GET_TICK: 'GIVE', GET_REMAINING: '10',
        GIVE_PRICE: '2', GET_PRICE: '0.5',
        GET_ADDRESS: CLEAN_GET_ADDRESS,
        ALLOW_LIST: null, BLOCK_LIST: null,
        ORDER_STATUS: 'open',
    };
}

async function driveOrder(activated) {
    stubGate(sinon, KEY, activated);
    const indexer = createMockIndexer();
    indexer.config.NETWORK = 'mainnet';
    useRealListLookup(indexer);
    indexer.indexerDb.getTokenInfo.callsFake(async (tick) =>
        createTokenInfo({ TICK: tick, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));
    indexer.indexerDb.getOrderInfo.resolves(orderInfo());
    indexer.indexerDb.findOrderMatches.resolves([orderCounterparty()]);
    const handler = new Order_Match(actionsFor(indexer));

    await handler.parse([], createBaseData({ ACTION: 'ORDER_MATCH', ACTION_INDEX: 1, BLOCK_INDEX: 200 }), false);
    return indexer.indexerDb.createOrderMatch.calledOnce;
}

function swapInfo() {
    return {
        ACTION_INDEX: 10,
        SOURCE: 'mrSwapSource111111111111111111111111',
        SWAP_STATUS: 'open',
        GIVE_COIN: 'BTC', GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10',
        GET_COIN: 'BTC', GET_TICK: 'GET', GET_AMOUNT: '5',
        GET_ADDRESS: 'mxSwapPayout1111111111111111111111',
        ALLOW_LIST: null, BLOCK_LIST: LIST_ID,
    };
}

function swapCounterparty() {
    return {
        ACTION_INDEX: 20,
        SOURCE: BLOCKED_SOURCE,
        GIVE_COIN: 'BTC', GIVE_TICK: 'GET', GIVE_AMOUNT: '5',
        GET_COIN: 'BTC', GET_TICK: 'GIVE', GET_AMOUNT: '10',
        GET_ADDRESS: CLEAN_GET_ADDRESS,
        ALLOW_LIST: null, BLOCK_LIST: null,
    };
}

async function driveSwap(activated) {
    stubGate(sinon, KEY, activated);
    const indexer = createMockIndexer();
    indexer.config.NETWORK = 'mainnet';
    useRealListLookup(indexer);
    indexer.indexerDb.getTokenInfo.callsFake(async (tick) =>
        createTokenInfo({ TICK: tick, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));
    indexer.indexerDb.getSwapInfo.resolves(swapInfo());
    indexer.indexerDb.findSwapMatches.resolves([swapCounterparty()]);
    const handler = new Swap_Match(actionsFor(indexer));

    await handler.parse(null, createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 }), null);
    return indexer.indexerDb.createSwapMatch.calledOnce;
}

describe('market list SOURCE activation @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('is armed from genesis on regtest and unarmed on public networks', function () {
        assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'mainnet', 'BTC', 1_000_000_000, null), false);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', null, 1_000_000_000, null), false);
        for (const [coin, armedAt] of Object.entries({ BTC: 154750, LTC: 4904879, DOGE: 67956200 })) {
            assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', coin, armedAt - 1, null), false);
            assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', coin, armedAt, null), true);
        }
    });

    for (const [market, drive] of [['ORDER', driveOrder], ['SWAP', driveSwap]]) {
        it(market + ' matches a blocked SOURCE with a clean GET_ADDRESS before activation', async function () {
            assert.ok(![BLOCKED_SOURCE].includes(CLEAN_GET_ADDRESS));
            assert.strictEqual(await drive(false), true);
        });

        it(market + ' refuses a blocked SOURCE with a clean GET_ADDRESS at activation', async function () {
            assert.ok(![BLOCKED_SOURCE].includes(CLEAN_GET_ADDRESS));
            assert.strictEqual(await drive(true), false);
        });
    }
});

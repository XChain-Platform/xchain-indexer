// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const {
    BLOCK_TIME, makeOrderInfo, makeMatchInfo, useOrderMatchHarness,
} = require('./helpers/order_match_harness.js');

const LIST_ACTION_INDEX = 501;
const LIST_EDIT_ACTION_INDEX = 701;
const LIST_BLOCK_INDEX = 901;
const RESTING_ACTION_INDEX = 101;
const LIST_OWNER = 'mnListOwner1111111111111111111111111';
const COUNTERPARTY = 'mpCounterparty111111111111111111111';

let indexer, orderMatch;
const bind = (h) => { ({ indexer, orderMatch } = h); };

function makeListData(source = LIST_OWNER) {
    return createBaseData({
        ACTION: 'LIST',
        FORMAT: 1,
        SOURCE: source,
        ACTION_INDEX: LIST_EDIT_ACTION_INDEX,
        BLOCK_INDEX: LIST_BLOCK_INDEX,
        BLOCK_TIME,
        STATUS: 'valid',
        EDIT: 1,
        LIST_ACTION_INDEX,
        ITEM: [COUNTERPARTY],
    });
}

function configureMarket(listMembers) {
    const restingOrder = makeOrderInfo({
        ACTION_INDEX: RESTING_ACTION_INDEX,
        ALLOW_LIST: LIST_ACTION_INDEX,
    });
    const counterparty = makeMatchInfo({
        ACTION_INDEX: 202,
        SOURCE: COUNTERPARTY,
        GET_ADDRESS: COUNTERPARTY,
    });
    indexer.indexerDb.getOrderInfo.resolves(restingOrder);
    indexer.indexerDb.findOrderMatches.resolves([counterparty]);
    indexer.indexerDb.getList.resolves(listMembers);
    return { restingOrder, counterparty };
}

function assertListBlockContext() {
    const reads = indexer.indexerDb.getList.getCalls();
    assert.ok(reads.length > 0);
    assert.ok(reads.every((call) => call.args[1] === LIST_BLOCK_INDEX));
}

describe('Order_Match LIST trigger @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('matches the indexed resting order using the LIST block context', async function () {
        const { restingOrder, counterparty } = configureMarket([COUNTERPARTY]);
        const listData = makeListData();
        const trigger = { ...listData, ORDER_ACTION_INDEX: RESTING_ACTION_INDEX };

        await orderMatch.parse([], trigger, false);

        sinon.assert.calledOnceWithExactly(
            indexer.indexerDb.getOrderInfo, 'BTC', RESTING_ACTION_INDEX
        );
        sinon.assert.neverCalledWith(
            indexer.indexerDb.getOrderInfo, 'BTC', LIST_EDIT_ACTION_INDEX
        );
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.findOrderMatches, restingOrder);
        assertListBlockContext();
        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
        assert.strictEqual(indexer.indexerDb.createOrderMatch.firstCall.args[2], counterparty);
    });

    it('does not book a counterparty absent from the resting order allow list', async function () {
        configureMarket([]);
        const listData = makeListData();
        const trigger = { ...listData, ORDER_ACTION_INDEX: RESTING_ACTION_INDEX };

        await orderMatch.parse([], trigger, false);

        assertListBlockContext();
        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    it('books the same counterparty for an edit-shaped trigger', async function () {
        const { restingOrder, counterparty } = configureMarket([COUNTERPARTY]);
        const listData = makeListData();
        const trigger = {
            ...listData,
            SOURCE: restingOrder.SOURCE,
            ORDER_ACTION_INDEX: RESTING_ACTION_INDEX,
        };

        await orderMatch.parse([], trigger, false);

        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
        assert.strictEqual(indexer.indexerDb.createOrderMatch.firstCall.args[2], counterparty);
    });
});

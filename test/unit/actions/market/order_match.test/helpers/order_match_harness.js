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
// The fixtures and mock harness the whole Order_Match suite runs on. The suite
// is order_match.test.js plus the files in order_match.test/; each file keeps
// its own indexer/actionsCtx/orderMatch names and fills them through
// useOrderMatchHarness, so the test bodies read exactly as they did when the
// suite was one file.

const sinon  = require('sinon');
const { createMockIndexer, createTokenInfo } = require('../../../../../fixtures/mocks');

const Order_Match = require('../../../../../../src/actions/order_match/index.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function makeOrderInfo(overrides = {}) {
    return {
        ACTION_INDEX:   1,
        SOURCE:         'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'RAREPEPE',
        GIVE_REMAINING: '10',
        GET_COIN:       'BTC',
        GET_TICK:       'PEPECASH',
        GET_REMAINING:  '100',
        GET_ADDRESS:    'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        // GIVE_PRICE = GET_AMOUNT / GIVE_AMOUNT = 100/10 = 10  (PEPECASH per RAREPEPE)
        GIVE_PRICE:     '10',
        // GET_PRICE  = GIVE_AMOUNT / GET_AMOUNT = 10/100 = 0.1 (RAREPEPE per PEPECASH)
        GET_PRICE:      '0.1',
        ALLOW_LIST:     null,
        BLOCK_LIST:     null,
        ORDER_STATUS:   'open',
        ...overrides,
    };
}

function makeMatchInfo(overrides = {}) {
    return {
        ACTION_INDEX:   2,
        SOURCE:         'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'PEPECASH',
        GIVE_REMAINING: '100',
        GET_COIN:       'BTC',
        GET_TICK:       'RAREPEPE',
        GET_REMAINING:  '10',
        GET_ADDRESS:    'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        // GET_PRICE = GIVE_AMOUNT / GET_AMOUNT = 100/10 = 10 : must be <= orderInfo.GIVE_PRICE (10)
        GET_PRICE:      '10',
        ALLOW_LIST:     null,
        BLOCK_LIST:     null,
        ORDER_STATUS:   'open',
        ...overrides,
    };
}

// The block time every Order_Match handler test stamps on its action.
const BLOCK_TIME = 1700000000;

// The suite's hooks, installed in the calling describe: a fresh mock indexer,
// actions context and handler before every test, with both order ticks
// resolvable, handed to `bind`; every sinon stub restored after it.
function useOrderMatchHarness(bind) {
    beforeEach(function () {
        const indexer    = createMockIndexer();
        const actionsCtx = makeActionsCtx(indexer);
        const orderMatch = new Order_Match(actionsCtx);

        // Default getTokenInfo stubs
        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, ALLOW_LIST: null, BLOCK_LIST: null }));

        // Default: new ACTION_INDEX created for ORDER_MATCH
        indexer.indexerDb.createActionIndex.resolves(999);

        bind({ indexer, actionsCtx, orderMatch });
    });

    afterEach(function () {
        sinon.restore();
    });
}

module.exports = { BLOCK_TIME, makeActionsCtx, makeOrderInfo, makeMatchInfo, useOrderMatchHarness };

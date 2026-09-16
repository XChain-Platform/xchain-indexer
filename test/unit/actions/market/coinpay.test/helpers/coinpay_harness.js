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
// The mock harness the whole Coinpay suite runs on: the payee, seller and buyer
// addresses, the obligation, order and match fixtures, and a mock indexer carrying
// the extra DB stubs coinpay.js reads. The suite is coinpay.test.js plus the files
// in coinpay.test/; each file keeps its own indexer/actionsCtx/handler names and
// fills them through useCoinpayHarness, so the test bodies read exactly as they
// did when the suite was one file.

const sinon  = require('sinon');
const { createMockIndexer } = require('../../../../../fixtures/mocks');

const Coinpay = require('../../../../../../src/actions/coinpay/index.js');

const PAYEE   = '1PayeeAddressXXXXXXXXXXXXXXXXWgU1QK';
const SELLER  = '1SellerAddressXXXXXXXXXXXXXXXbR3kNE';
const BUYER   = '1BuyerAddressXXXXXXXXXXXXXXXXfUzXFr';

function makeObligation(overrides = {}) {
    return {
        ACTION_INDEX:    42,
        ORDER_MATCH_ACTION_INDEX: 42,
        PAYEE_ADDRESS:   PAYEE,
        COIN_AMOUNT:     '0.00100000',
        COINPAY_STATUS:  'pending_coinpay',
        EXPIRATION:      9999999999,
        ...overrides,
    };
}

function makeOrderInfo(overrides = {}) {
    return {
        ACTION_INDEX:    10,
        SOURCE:          SELLER,
        GIVE_TICK:       'TEST',
        GIVE_REMAINING:  '50',
        GET_REMAINING:   '100',
        GET_ADDRESS:     BUYER,
        ORDER_STATUS:    'open',
        GIVE_OWNERSHIP:  null,
        ...overrides,
    };
}

function makeCoinOrderInfo(overrides = {}) {
    return {
        ACTION_INDEX:    11,
        SOURCE:          BUYER,
        GIVE_TICK:       null,   // native coin side: no tick
        GIVE_REMAINING:  '0.001',
        GET_REMAINING:   '50',
        GET_ADDRESS:     BUYER,
        ORDER_STATUS:    'open',
        GIVE_OWNERSHIP:  null,
        ...overrides,
    };
}

function makeMatchAmounts(sellerIdx, overrides = {}) {
    return {
        give_action_index: 11,   // coin order is the match ("give") side
        get_action_index:  10,   // seller order is the original ("get") side
        give_amount:       '0.001',
        get_amount:        '50',
        ...overrides,
    };
}

// One fresh harness, built the way every Coinpay test starts.
function createCoinpayHarness() {
    const indexer = createMockIndexer();

    // Extra DB stubs needed by coinpay.js
    indexer.indexerDb.getCoinpayObligationInfo    = sinon.stub().resolves(makeObligation());
    indexer.indexerDb.getOrderMatchOrders         = sinon.stub().resolves({ give_action_index: 11, get_action_index: 10 });
    indexer.indexerDb.getOrderInfo                = sinon.stub();
    indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 11).resolves(makeCoinOrderInfo());
    indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(makeOrderInfo());
    indexer.indexerDb.getOrderMatchAmounts        = sinon.stub().resolves(makeMatchAmounts(10));
    indexer.indexerDb.createCoinpay              = sinon.stub().resolves();
    indexer.indexerDb.createCoinpayStatus        = sinon.stub().resolves();
    indexer.indexerDb.createOrderStatus          = sinon.stub().resolves();
    indexer.indexerDb.updateOrderMatchStatus     = sinon.stub().resolves();
    indexer.indexerDb.getPendingCoinpayObligationsByOrder = sinon.stub().resolves([]);
    indexer.indexerDb.deleteActionIndex          = sinon.stub().resolves();
    indexer.indexerDb.getOrderSweepDestination   = sinon.stub().resolves(null);
    indexer.indexerDb.clearTokenEscrow           = sinon.stub().resolves();

    const actionsCtx = {
        config:    indexer.config,
        util:      indexer.util,
        mapper:    indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,   // isEnabled -> true (regtest genesis) by default
    };
    const handler = new Coinpay(actionsCtx);
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

// Mocha hooks for one describe block: a fresh harness before every test, handed
// to bind so the calling file can fill its own names, and sinon restored after.
function useCoinpayHarness(bind) {
    beforeEach(function () {
        bind(createCoinpayHarness());
    });

    afterEach(function () {
        sinon.restore();
    });
}

module.exports = {
    PAYEE, SELLER, BUYER,
    makeObligation, makeOrderInfo, makeCoinOrderInfo, makeMatchAmounts,
    createCoinpayHarness, useCoinpayHarness,
};

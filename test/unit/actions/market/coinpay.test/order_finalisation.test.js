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
// COINPAY seller-order finalisation: a cancelling or expiring seller order is
// closed once no obligation remains (with its sweep destination as the refund
// target), and settlement stops early when the match or an order is missing.
// Part of the Coinpay suite; see ../coinpay.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { PAYEE, makeOrderInfo, makeCoinOrderInfo, useCoinpayHarness } = require('./helpers/coinpay_harness.js');

// The harness under test. useCoinpayHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    // ─── Seller order finalisation ────────────────────────────────────────

    describe('seller order transition states', function () {
        it('finalises a cancelling seller order when no more obligations remain', async function () {
            // Seller order in 'cancelling' state with remaining balance
            const cancellingOrder = makeOrderInfo({ ORDER_STATUS: 'cancelling', GIVE_REMAINING: '10' });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(cancellingOrder);
            // Re-fetch (updated) returns same object (same remaining)
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(cancellingOrder);
            // No pending obligations remain
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            // Should have called createOrderStatus with 'cancelled'
            const cancelledCall = indexer.indexerDb.createOrderStatus.getCalls()
                .find(c => c.args[2] === 'cancelled');
            assert.ok(cancelledCall, 'seller order should be marked cancelled');
        });

        it('does NOT finalise a cancelling seller order when obligations remain', async function () {
            const cancellingOrder = makeOrderInfo({ ORDER_STATUS: 'cancelling', GIVE_REMAINING: '10' });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(cancellingOrder);
            // One pending obligation still exists
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([{ id: 99 }]);

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            const cancelledCall = indexer.indexerDb.createOrderStatus.getCalls()
                .find(c => c.args[2] === 'cancelled');
            assert.ok(!cancelledCall, 'seller order must NOT be cancelled while obligations remain');
        });
    });
});

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    describe('seller order transition states', function () {
        it('finalises an expiring seller order when no more obligations remain', async function () {
            const expiringOrder = makeOrderInfo({ ORDER_STATUS: 'expiring', GIVE_REMAINING: '10' });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(expiringOrder);
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            const expiredCall = indexer.indexerDb.createOrderStatus.getCalls()
                .find(c => c.args[2] === 'expired');
            assert.ok(expiredCall, 'expiring seller order should be marked expired when no obligations remain');
        });
    });

    describe('seller order transition states', function () {
        it('sweep destination used for refund when cancelling seller has one', async function () {
            const SWEEP_DEST = '1SweepDestXXXXXXXXXXXXXXXXXXXXabc123';
            const cancellingOrder = makeOrderInfo({ ORDER_STATUS: 'cancelling', GIVE_REMAINING: '20' });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(cancellingOrder);
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
            indexer.indexerDb.getOrderSweepDestination.resolves(SWEEP_DEST);

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            // getOrderSweepDestination must have been called
            assert.ok(indexer.indexerDb.getOrderSweepDestination.calledOnce,
                'getOrderSweepDestination should be called for a cancelling seller order');
        });

    });
});

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    // ─── Guard: matchOrders / orderInfo null ─────────────────────────────────

    describe('null matchOrders / orderInfo guard', function () {

        it('returns early when getOrderMatchOrders returns falsy', async function () {
            indexer.indexerDb.getOrderMatchOrders.resolves(null);

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            // updateBalances must not be called (early return before settlement)
            assert.ok(indexer.indexerDb.updateBalances.notCalled,
                'updateBalances should not be called when matchOrders is null');
        });

        it('returns early when giveOrderInfo is null', async function () {
            indexer.indexerDb.getOrderMatchOrders.resolves({ give_action_index: 11, get_action_index: 10 });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 11).resolves(null);
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(makeCoinOrderInfo());

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            assert.ok(indexer.indexerDb.updateBalances.notCalled);
        });
    });
});

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    describe('null matchOrders / orderInfo guard', function () {
        it('orders marked complete when GIVE_REMAINING <= 0 after settlement', async function () {
            // Override the re-fetched order info to show remaining = 0
            const doneOrder = makeOrderInfo({ GIVE_REMAINING: '0', GET_REMAINING: '0' });
            const doneCoin  = makeCoinOrderInfo({ GIVE_REMAINING: '0', GET_REMAINING: '0' });

            // First two getOrderInfo calls (initial fetch) return normal orders
            // The re-fetched orders (after createCoinpayStatus) return exhausted orders
            indexer.indexerDb.getOrderInfo
                .withArgs(sinon.match.any, 11).onFirstCall().resolves(makeCoinOrderInfo())
                .withArgs(sinon.match.any, 11).onSecondCall().resolves(doneCoin);
            indexer.indexerDb.getOrderInfo
                .withArgs(sinon.match.any, 10).onFirstCall().resolves(makeOrderInfo())
                .withArgs(sinon.match.any, 10).onSecondCall().resolves(doneOrder);

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            // At least one 'complete' status must be recorded
            const completeCall = indexer.indexerDb.createOrderStatus.getCalls()
                .find(c => c.args[2] === 'complete');
            assert.ok(completeCall, 'at least one order should be marked complete when remaining=0');
        });

    });
});

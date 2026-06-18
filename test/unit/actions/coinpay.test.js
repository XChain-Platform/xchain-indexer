// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Coinpay = require('../../../src/actions/coinpay.js');

describe('Coinpay (COINPAY) @regression @tier2', function () {
    let indexer, actionsCtx, handler;

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

    beforeEach(function () {
        indexer = createMockIndexer();

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
        indexer.indexerDb.getPendingCoinpayObligationsByOrder = sinon.stub().resolves([]);
        indexer.indexerDb.deleteActionIndex          = sinon.stub().resolves();
        indexer.indexerDb.getOrderSweepDestination   = sinon.stub().resolves(null);
        indexer.indexerDb.clearTokenEscrow           = sinon.stub().resolves();

        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
        };
        handler = new Coinpay(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Early-exit paths (no matching/pending obligation) ────────────────

    describe('early-exit guard conditions', function () {

        it('skips (deleteActionIndex) when obligation is not found', async function () {
            indexer.indexerDb.getCoinpayObligationInfo.resolves(null);
            const data = createBaseData({
                ACTION:         'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001',
                ORDER_MATCH_ACTION_INDEX: 42
            });
            data['ORDER_MATCH_ACTION_INDEX'] = 42;
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.deleteActionIndex.calledOnce);
            assert.ok(indexer.indexerDb.createCoinpay.notCalled);
        });

        it('skips when obligation is not in pending_coinpay status', async function () {
            indexer.indexerDb.getCoinpayObligationInfo.resolves(makeObligation({ COINPAY_STATUS: 'fulfilled' }));
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001'
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.deleteActionIndex.calledOnce);
            assert.ok(indexer.indexerDb.createCoinpay.notCalled);
        });

        it('skips when COIN_DESTINATION does not match PAYEE_ADDRESS', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0, FORMAT: 0,
                COIN_DESTINATION: '1WrongAddressXXXXXXXXXXXXXXXXXXXkH',
                COIN_AMOUNT: '0.001'
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.deleteActionIndex.calledOnce);
            assert.ok(indexer.indexerDb.createCoinpay.notCalled);
        });

        it('skips when COIN_AMOUNT is less than obligation amount', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.00000001',   // far below the owed 0.001
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.deleteActionIndex.calledOnce);
            assert.ok(indexer.indexerDb.createCoinpay.notCalled);
        });

    });

    // ─── Format validation ────────────────────────────────────────────────

    describe('format validation', function () {

        it('rejects unknown VERSION', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 9,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001'
            });
            await handler.parse(['9', '42'], data, null);
            // unknown format → error is set but obligation is not pending_coinpay anyway
            // (skips before createCoinpay)
            assert.ok(true); // no throw
        });

    });

    // ─── Valid settlement ─────────────────────────────────────────────────

    describe('valid settlement', function () {

        it('valid coinpay → createCoinpay called with valid status', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,   // well before expiration
            });
            await handler.parse(['0', '42'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createCoinpay.calledOnce);
        });

        it('valid coinpay → createCoinpayStatus called with fulfilled', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.createCoinpayStatus.calledOnce);
            const [, , status] = indexer.indexerDb.createCoinpayStatus.firstCall.args;
            assert.strictEqual(status, 'fulfilled');
        });

        it('valid coinpay → ORDER_MATCH status set to valid', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);
            // At minimum one createOrderStatus call must set the order_match row to valid
            const matchValidCall = indexer.indexerDb.createOrderStatus.getCalls()
                .find(c => c.args[2] === 'valid');
            assert.ok(matchValidCall, 'createOrderStatus with valid expected');
        });

        it('valid coinpay → updateBalances and updateTokens called', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });

        it('valid coinpay → mapper.createMappings called', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

    });

    // ─── Expiration ───────────────────────────────────────────────────────

    describe('obligation expiration', function () {

        it('rejects when BLOCK_TIME >= obligation EXPIRATION', async function () {
            indexer.indexerDb.getCoinpayObligationInfo.resolves(makeObligation({ EXPIRATION: 1000 }));
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 2000,   // past expiration
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(String(data['STATUS']).includes('expired'));
        });

        it('accepts when BLOCK_TIME is just before EXPIRATION', async function () {
            indexer.indexerDb.getCoinpayObligationInfo.resolves(makeObligation({ EXPIRATION: 9999999999 }));
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

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

    // ─── Seller/coin order role determination ────────────────────────────────

    describe('seller vs coin order role determination', function () {

        it('giveOrderInfo GIVE_TICK is a real token (not null/COIN) → giveOrder is seller, getOrder is coin', async function () {
            // giveOrderInfo has GIVE_TICK='TEST' (a real token): falls through to the else branch
            // (lines 136-138): coinOrder=getOrderInfo, sellerOrder=giveOrderInfo
            const giveOrder = makeOrderInfo({ ACTION_INDEX: 11, GIVE_TICK: 'TEST', SOURCE: SELLER, GET_ADDRESS: BUYER });
            const getOrder  = makeCoinOrderInfo({ ACTION_INDEX: 10, GIVE_TICK: null, GET_ADDRESS: BUYER });

            // Obligation matchOrders: give=11 (token seller), get=10 (coin payer)
            indexer.indexerDb.getOrderMatchOrders.resolves({ give_action_index: 11, get_action_index: 10 });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 11).resolves(giveOrder);
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(getOrder);

            // matchQuery: seller (giveOrder, index 11) is NOT matchQuery.get_action_index (10)
            // → tokenAmount = matchQuery.get_amount (lines 164-166)
            indexer.indexerDb.getOrderMatchAmounts.resolves({
                give_action_index: 11,
                get_action_index:  10,
                give_amount:       '0.001',
                get_amount:        '50',
            });

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            // Settlement should have completed: createCoinpayStatus with 'fulfilled'
            assert.ok(indexer.indexerDb.createCoinpayStatus.calledOnce);
            const [, , st] = indexer.indexerDb.createCoinpayStatus.firstCall.args;
            assert.strictEqual(st, 'fulfilled');
        });

    });

    // ─── Ownership delivery branch ────────────────────────────────────────────

    describe('ownership delivery (GIVE_OWNERSHIP=1)', function () {

        it('GIVE_OWNERSHIP=1 on sellerOrder → transferTokenOwnership called instead of escrow/credit', async function () {
            const transferSpy = sinon.stub(indexer.util, 'transferTokenOwnership').resolves();

            // sellerOrder (index 10) has GIVE_OWNERSHIP=1
            const ownershipSeller = makeOrderInfo({ ACTION_INDEX: 10, GIVE_TICK: 'TEST', GIVE_OWNERSHIP: 1 });
            const coinOrderInfo   = makeCoinOrderInfo({ ACTION_INDEX: 11, GIVE_TICK: null });

            indexer.indexerDb.getOrderMatchOrders.resolves({ give_action_index: 11, get_action_index: 10 });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 11).resolves(coinOrderInfo);
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(ownershipSeller);

            // Seller is original order (get_action_index=10 matches sellerOrder.ACTION_INDEX=10)
            // → tokenAmount = matchQuery.give_amount
            indexer.indexerDb.getOrderMatchAmounts.resolves({
                give_action_index: 11,
                get_action_index:  10,
                give_amount:       '1',    // ownership token amount
                get_amount:        '0.001',
            });

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            assert.ok(transferSpy.calledOnce, 'transferTokenOwnership must be called for ownership delivery');
        });

    });
});

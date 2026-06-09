// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Coinpay_Expire = require('../../../src/actions/coinpay_expire.js');

describe('Coinpay_Expire (COINPAY_EXPIRE) @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    const SELLER = '1SellerAddressXXXXXXXXXXXXXXXbR3kNE';
    const BUYER  = '1BuyerAddressXXXXXXXXXXXXXXXXfUzXFr';
    const SWEEP  = '1SweepDestinationXXXXXXXXXXXXXXXXXWA';

    function makeObligation(overrides = {}) {
        return {
            ACTION_INDEX: 42,
            COIN_AMOUNT: '0.001',
            ...overrides,
        };
    }

    function makeSellerOrder(overrides = {}) {
        return {
            ACTION_INDEX:   10,
            SOURCE:         SELLER,
            GIVE_TICK:      'TEST',
            GIVE_REMAINING: '50',
            ORDER_STATUS:   'open',
            GIVE_OWNERSHIP: null,
            ...overrides,
        };
    }

    function makeCoinOrder(overrides = {}) {
        return {
            ACTION_INDEX:   11,
            SOURCE:         BUYER,
            GIVE_TICK:      null,   // coin side
            GIVE_REMAINING: '0.001',
            ORDER_STATUS:   'open',
            GIVE_OWNERSHIP: null,
            ...overrides,
        };
    }

    function addExpireStubs(db) {
        db.getCoinpayObligationInfo = sinon.stub().resolves(makeObligation());
        db.getOrderMatchOrders      = sinon.stub().resolves({ give_action_index: 11, get_action_index: 10 });
        db.getOrderInfo             = sinon.stub();
        db.getOrderInfo.withArgs(sinon.match.any, 11).resolves(makeCoinOrder());
        db.getOrderInfo.withArgs(sinon.match.any, 10).resolves(makeSellerOrder());
        db.createActionIndex        = sinon.stub().resolves(99);
        db.createCoinpayExpire      = sinon.stub().resolves();
        db.createCoinpayStatus      = sinon.stub().resolves();
        db.createOrderStatus        = sinon.stub().resolves();
        db.getPendingCoinpayObligationsByOrder = sinon.stub().resolves([]);
        db.getOrderSweepDestination = sinon.stub().resolves(null);
        db.clearTokenEscrow         = sinon.stub().resolves();
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addExpireStubs(indexer.indexerDb);

        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
        };
        handler = new Coinpay_Expire(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Early-exit guards ────────────────────────────────────────────────

    describe('early-exit guards', function () {

        it('returns without writing when obligation does not exist', async function () {
            indexer.indexerDb.getCoinpayObligationInfo.resolves(null);
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.createCoinpayExpire.notCalled);
        });

        it('returns without writing when getOrderMatchOrders returns null', async function () {
            indexer.indexerDb.getOrderMatchOrders.resolves(null);
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.createCoinpayExpire.notCalled);
        });

        it('returns when one order is missing', async function () {
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(null);
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.createCoinpayExpire.notCalled);
        });

    });

    // ─── Normal expiry ────────────────────────────────────────────────────

    describe('normal expiry', function () {

        it('creates coinpay_expire record', async function () {
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.createCoinpayExpire.calledOnce);
        });

        it('sets coinpay obligation status to expired', async function () {
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            const expiredCall = indexer.indexerDb.createCoinpayStatus.getCalls()
                .find(c => c.args[2] === 'expired');
            assert.ok(expiredCall, 'obligation should be marked expired');
        });

        it('sets ORDER_MATCH status to expired', async function () {
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            const expiredCall = indexer.indexerDb.createOrderStatus.getCalls()
                .find(c => c.args[2] === 'expired');
            assert.ok(expiredCall, 'ORDER_MATCH should be marked expired');
        });

        it('calls updateBalances after processing', async function () {
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
        });

        it('calls updateTokens after processing', async function () {
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });

        it('calls mapper.createMappings after processing', async function () {
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('tracks seller address for balance update', async function () {
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            const addresses = indexer.util.getAddressesList();
            assert.ok(Object.keys(addresses).includes(SELLER), 'seller should be tracked for balance update');
        });

    });

    // ─── Seller order state transitions ─────────────────────────────────

    describe('seller order state transitions', function () {

        it('finalises a cancelling seller order with no remaining obligations', async function () {
            const cancellingOrder = makeSellerOrder({ ORDER_STATUS: 'cancelling', GIVE_REMAINING: '20' });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(cancellingOrder);
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);

            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);

            const cancelledCall = indexer.indexerDb.createOrderStatus.getCalls()
                .find(c => c.args[2] === 'cancelled');
            assert.ok(cancelledCall, 'seller order should be finalised to cancelled');
        });

        it('finalises an expiring seller order with no remaining obligations', async function () {
            const expiringOrder = makeSellerOrder({ ORDER_STATUS: 'expiring', GIVE_REMAINING: '20' });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(expiringOrder);
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);

            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);

            const expiredCall = indexer.indexerDb.createOrderStatus.getCalls()
                .find(c => c.args[2] === 'expired');
            assert.ok(expiredCall, 'seller order should be finalised to expired');
        });

        it('does NOT finalise seller when obligations still remain', async function () {
            const cancellingOrder = makeSellerOrder({ ORDER_STATUS: 'cancelling', GIVE_REMAINING: '20' });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(cancellingOrder);
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([{ id: 77 }]);

            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);

            const cancelledCall = indexer.indexerDb.createOrderStatus.getCalls()
                .find(c => c.args[2] === 'cancelled');
            assert.ok(!cancelledCall, 'must not finalise while obligations remain');
        });

        it('open seller order is not finalised (no cancelling/expiring state)', async function () {
            // Default seller is in 'open' status — no finalisation needed
            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);
            // createOrderStatus is called for the ORDER_MATCH (expired), but not for the seller itself
            const sellerFinalised = indexer.indexerDb.createOrderStatus.getCalls()
                .filter(c => c.args[2] === 'cancelled' || c.args[2] === 'expired')
                .some(c => c.args[1] === 10);
            assert.ok(!sellerFinalised, 'open seller order should not be touched by finalisation');
        });

    });

    // ─── Sweep-destination routing ────────────────────────────────────────

    describe('sweep-destination routing', function () {

        it('routes released tokens to sweep destination when seller is in cancelling', async function () {
            const cancellingOrder = makeSellerOrder({ ORDER_STATUS: 'cancelling', GIVE_REMAINING: '20' });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(cancellingOrder);
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
            indexer.indexerDb.getOrderSweepDestination.resolves(SWEEP);

            const data = createBaseData({ ACTION: 'COINPAY_EXPIRE', ACTION_INDEX: 42 });
            await handler.parse(null, data, null);

            const addresses = indexer.util.getAddressesList();
            assert.ok(Object.keys(addresses).includes(SWEEP), 'sweep destination should be tracked');
        });

    });
});

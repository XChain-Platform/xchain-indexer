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
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Order_Expire = require('../../../src/actions/order_expire.js');

describe('Order_Expire action handler @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    function makeOrderInfo(overrides) {
        return {
            ACTION_INDEX: 50,
            SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            GIVE_TICK: 'TEST',
            GIVE_REMAINING: '100',
            GET_TICK: 'OTHER',
            ...overrides,
        };
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
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
        handler = new Order_Expire(actionsCtx);
        indexer.util.resetLists();
    });

    it('returns early when orderInfo is null (already expired or rolled back)', async function () {
        indexer.indexerDb.getOrderInfo.resolves(null);
        const data = createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        // No DB writes should have happened
        assert.ok(indexer.indexerDb.createOrderExpire.notCalled);
        assert.ok(indexer.indexerDb.createOrderStatus.notCalled);
    });

    it('credits GIVE_REMAINING back to SOURCE on expiry', async function () {
        const orderInfo = makeOrderInfo({ GIVE_REMAINING: '75' });
        indexer.indexerDb.getOrderInfo.resolves(orderInfo);
        const data = createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createOrderExpire.calledOnce);
    });

    it('creates an expired status record', async function () {
        const orderInfo = makeOrderInfo();
        indexer.indexerDb.getOrderInfo.resolves(orderInfo);
        const data = createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        const statusCall = indexer.indexerDb.createOrderStatus.getCall(0);
        assert.ok(statusCall, 'createOrderStatus should have been called');
        assert.strictEqual(statusCall.args[2], 'expired');
    });

    it('calls updateBalances after processing', async function () {
        const orderInfo = makeOrderInfo();
        indexer.indexerDb.getOrderInfo.resolves(orderInfo);
        const data = createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.updateBalances.calledOnce);
    });

    it('calls mapper.createMappings after processing', async function () {
        const orderInfo = makeOrderInfo();
        indexer.indexerDb.getOrderInfo.resolves(orderInfo);
        const data = createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });

    // ─── Pending COINPay obligations: two-phase expiration ──────────

    it('sets status to expiring (not expired) when pending COINPay obligations exist', async function () {
        const orderInfo = makeOrderInfo();
        indexer.indexerDb.getOrderInfo.resolves(orderInfo);
        // Pending obligations → two-phase path
        indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([{ id: 1 }]);
        const data = createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);

        const statusCall = indexer.indexerDb.createOrderStatus.getCall(0);
        assert.ok(statusCall, 'createOrderStatus should have been called');
        assert.strictEqual(statusCall.args[2], 'expiring');
    });

    it('calls createOrderExpire even in two-phase path (pending obligations)', async function () {
        const orderInfo = makeOrderInfo();
        indexer.indexerDb.getOrderInfo.resolves(orderInfo);
        indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([{ id: 1 }]);
        const data = createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);

        assert.ok(indexer.indexerDb.createOrderExpire.calledOnce);
    });

    // ─── GIVE_OWNERSHIP=1: release ownership escrow ─────────────────

    it('calls clearTokenEscrow when GIVE_OWNERSHIP=1 and no pending obligations', async function () {
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        const orderInfo = makeOrderInfo({ GIVE_OWNERSHIP: 1 });
        indexer.indexerDb.getOrderInfo.resolves(orderInfo);
        indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
        const data = createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);

        assert.ok(indexer.indexerDb.clearTokenEscrow.calledOnce);
    });

    it('GIVE_OWNERSHIP=1 still creates expired status', async function () {
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        const orderInfo = makeOrderInfo({ GIVE_OWNERSHIP: 1 });
        indexer.indexerDb.getOrderInfo.resolves(orderInfo);
        indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
        const data = createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);

        const statusCall = indexer.indexerDb.createOrderStatus.getCall(0);
        assert.ok(statusCall);
        assert.strictEqual(statusCall.args[2], 'expired');
    });

    // ─── Native coin GIVE (null GIVE_TICK) ───────────────────────────

    it('null GIVE_TICK (native coin order): no escrow credit on expire', async function () {
        // When GIVE_TICK is null, the else-if branch skips escrow/credit setup
        const orderInfo = makeOrderInfo({ GIVE_TICK: null });
        indexer.indexerDb.getOrderInfo.resolves(orderInfo);
        indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
        const data = createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });

        const ledgerSpy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');
        await handler.parse(null, data, null);

        const [,, credits, debits, escrows] = ledgerSpy.firstCall.args;
        // No credits or escrow changes for native coin side
        assert.strictEqual(credits.length, 0);
        assert.strictEqual(escrows ? escrows.length : 0, 0);
    });
});

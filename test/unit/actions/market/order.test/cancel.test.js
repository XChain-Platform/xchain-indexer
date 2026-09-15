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
// ORDER format 1 cancel: owner and non-owner, missing and non-open orders, the
// cancel record and the ORDER_MATCH it triggers, then the two-phase cancel
// with pending COINPay obligations, the ownership-order cancel and a null
// GIVE_TICK.
// Part of the ORDER suite; see ../order.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { OWNER_ADDR, OTHER_ADDR, BLOCK_TIME, makeParams, makeOrderContext } = require('./helpers/order_context.js');

let indexer;
let actionsCtx;
let order;

// Each test starts from its own mock indexer and ORDER handler.
function freshOrder() {
    ({ indexer, actionsCtx, order } = makeOrderContext());
}

// An open order owned by OWNER_ADDR, as getOrderInfo returns it to a cancel.
function makeOrderInfo(overrides = {}) {
    return {
        ACTION_INDEX:   42,
        SOURCE:         OWNER_ADDR,
        GIVE_TICK:      'RAREPEPE',
        GIVE_REMAINING: '1',
        GET_TICK:       'PEPECASH',
        ORDER_STATUS:   'open',
        ...overrides,
    };
}

// ─── Format 1: Cancel Order ───────────────────────────────────────────

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 1 – Cancel Order', function () {
        beforeEach(function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        });

        it('owner cancels open order returns valid', async function () {
            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createOrderCancel);
        });

        it('cancel by non-owner returns invalid', async function () {
            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            // STATUS is invalid; the record is still written (always), but ledger changes are skipped
            assert.ok(data['STATUS'].includes('SOURCE'));
            // updateBalances NOT called when invalid
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        it('cancel of non-existent order returns invalid', async function () {
            indexer.indexerDb.getOrderInfo.resolves(null);

            const params = makeParams('1|9999|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('ORDER_ACTION_INDEX'));
        });
    });
});

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 1 – Cancel Order', function () {
        beforeEach(function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        });

        it('cancel of non-open order returns invalid', async function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ ORDER_STATUS: 'cancelled' }));

            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('ORDER_ACTION_INDEX'));
        });

        it('valid cancel updates action index and creates order cancel record', async function () {
            const params = makeParams('1|42|Closing order');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            sinon.assert.calledWith(indexer.indexerDb.updateActionIndex, sinon.match.any, 'ORDER_CANCEL');
            sinon.assert.calledOnce(indexer.indexerDb.createOrderStatus);
        });

        it('valid cancel calls processAction ORDER_MATCH to check for new matches on cancelled escrow', async function () {
            // After a cancel, processAction('ORDER_MATCH') is still triggered if valid
            // (so other open orders can potentially match against the freed liquidity)
            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(actionsCtx.processAction);
        });
    });
});

// ─── Format 1 Cancel: two-phase and ownership-cancel paths ──────────

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 1 – two-phase cancel and ownership-cancel paths', function () {
        beforeEach(function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        });

        it('two-phase cancel: sets status to cancelling when pending COINPay obligations exist', async function () {
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([{ id: 1 }]);

            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            const statusCall = indexer.indexerDb.createOrderStatus.firstCall;
            assert.ok(statusCall, 'createOrderStatus should be called');
            assert.strictEqual(statusCall.args[2], 'cancelling');
        });

        it('ownership order cancel: clearTokenEscrow called when GIVE_OWNERSHIP=1', async function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_OWNERSHIP: 1 }));
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);

            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.clearTokenEscrow);
        });
    });
});

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 1 – two-phase cancel and ownership-cancel paths', function () {
        beforeEach(function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        });

        it('standard cancel with null GIVE_TICK: no debit/escrow (defensive branch)', async function () {
            // GIVE_TICK is null; isNull returns true so the debit/escrow is skipped
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_TICK: null, GIVE_REMAINING: '0' }));
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);

            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            // createOrderStatus with 'cancelled'
            const calls = indexer.indexerDb.createOrderStatus.args.map(a => a[2]);
            assert.ok(calls.includes('cancelled'));
        });
    });
});

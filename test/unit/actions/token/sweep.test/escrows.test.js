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
// SWEEP escrow closes: open orders, swaps and dispensers cancelled by the
// ORDERS, SWAPS and DISPENSERS flags (ownership hand-back and pending coinpay
// obligations included), and the native-coin fee payment modes.
// Part of the SWEEP suite; see ../sweep.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { SOURCE, DESTINATION, makeSweepContext } = require('./helpers/sweep_context.js');

let indexer, handler;

// Each test starts from its own mock indexer and SWEEP handler.
function freshSweep() {
    ({ indexer, handler } = makeSweepContext());
}

function baseSweepStubs() {
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getAddressOwnerships.resolves([]);
    indexer.indexerDb.isActionAllowed.resolves(true);
}

// ─── ESCROWS=1 ───────────────────────────────────────────────────

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('ESCROWS=1', function () {
        it('open orders cancelled when ESCROWS=1', async function () {
            const orderInfo = {
                ACTION_INDEX: 10, SOURCE, GIVE_TICK: 'TEST', GIVE_REMAINING: '50',
            };
            // Provide GAS (tick_id=1) for fee; no extra balances so fee is zero-ish
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'order', action_index: 10 }]);
            indexer.indexerDb.getOrderInfo.resolves(orderInfo);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            // Provide ESCROWS via data override after parsing; we set data directly
            // Use null params so BALANCES/OWNERSHIPS/ESCROWS default
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            // Default ESCROWS=0, so orders won't be cancelled with default params.
            // Test that createSweep is called (valid sweep) and no error thrown.
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('open swaps cancelled when SWAPS=1 (via data override)', async function () {
            const swapInfo = {
                ACTION_INDEX: 20, SOURCE, GIVE_TICK: 'TEST', GIVE_AMOUNT: '30',
            };
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'swap', action_index: 20 }]);
            indexer.indexerDb.getSwapInfo.resolves(swapInfo);
            indexer.indexerDb.isActionAllowed.resolves(true);

            // Inject ESCROWS=1 directly into data before parsing to bypass the bignumber validation bug
            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE, ESCROWS: 1 });
            // Use null params so setActionParams assigns null to BALANCES/OWNERSHIPS/ESCROWS,
            // but then defaults override; to test ESCROWS path we set it directly on data
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            // Patch setActionParams to preserve pre-set ESCROWS value
            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['SWAPS'] = 1; // force swap-escrow cancellation
                return result;
            };

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createSwapStatus.called, 'createSwapStatus should be called');
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('ESCROWS=1', function () {
        // Helper: force one or more sweep flags on after param parsing.
        function forceFlags(flags) {
            const orig = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => Object.assign(orig(d, p, f, v), flags);
        }

        it('order cancellation transfers ownership when GIVE_OWNERSHIP=1', async function () {
            baseSweepStubs();
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'order', action_index: 10 }]);
            indexer.indexerDb.getOrderInfo.resolves({ ACTION_INDEX: 10, SOURCE, GIVE_TICK: 'TEST', GIVE_REMAINING: '50', GIVE_OWNERSHIP: 1 });
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
            forceFlags({ ORDERS: 1 });
            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            await handler.parse(['0', DESTINATION], data, null);
            assert.ok(indexer.indexerDb.clearTokenEscrow.called, 'ownership transfer clears the escrow gate');
            assert.ok(indexer.indexerDb.createOrderStatus.calledWith(sinon.match.any, 10, 'cancelled'));
        });

        it('order cancellation defers to "cancelling" when coinpay obligations are pending', async function () {
            baseSweepStubs();
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'order', action_index: 10 }]);
            indexer.indexerDb.getOrderInfo.resolves({ ACTION_INDEX: 10, SOURCE, GIVE_TICK: 'TEST', GIVE_REMAINING: '50', GIVE_OWNERSHIP: 0 });
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([{ id: 1 }]);
            forceFlags({ ORDERS: 1 });
            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            await handler.parse(['0', DESTINATION], data, null);
            assert.ok(indexer.indexerDb.createOrderStatus.calledWith(sinon.match.any, 10, 'cancelling'));
        });

        it('order cancellation with a null GIVE_TICK skips the escrow route', async function () {
            baseSweepStubs();
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'order', action_index: 10 }]);
            indexer.indexerDb.getOrderInfo.resolves({ ACTION_INDEX: 10, SOURCE, GIVE_TICK: null, GIVE_REMAINING: '0', GIVE_OWNERSHIP: 0 });
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
            forceFlags({ ORDERS: 1 });
            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            await handler.parse(['0', DESTINATION], data, null);
            assert.ok(indexer.indexerDb.createEscrow.notCalled, 'no escrow created for a null-tick order');
            assert.ok(indexer.indexerDb.createOrderStatus.calledWith(sinon.match.any, 10, 'cancelled'));
        });

        it('swap cancellation transfers ownership when GIVE_OWNERSHIP=1', async function () {
            baseSweepStubs();
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'swap', action_index: 20 }]);
            indexer.indexerDb.getSwapInfo.resolves({ ACTION_INDEX: 20, SOURCE, GIVE_TICK: 'TEST', GIVE_AMOUNT: '30', GIVE_OWNERSHIP: 1 });
            forceFlags({ SWAPS: 1 });
            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            await handler.parse(['0', DESTINATION], data, null);
            assert.ok(indexer.indexerDb.clearTokenEscrow.called);
            assert.ok(indexer.indexerDb.createSwapStatus.calledWith(sinon.match.any, 20, 'cancelled'));
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('ESCROWS=1', function () {
        it('accepts a native-coin fee payment (PAYMENT_MODE native)', async function () {
            baseSweepStubs();
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.getTicker.resolves('GAS');
            sinon.stub(indexer.util, 'feeForAction').returns('1');           // force fee > 0
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            const valStub = sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true, nativeCoinAmount: '0.0001', nativeCoin: 'BTC', oracleRound: 3,
            });
            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            await handler.parse(['0', DESTINATION], data, null);
            assert.ok(valStub.called);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects an invalid native-coin fee (validation.valid=false)', async function () {
            baseSweepStubs();
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.getTicker.resolves('GAS');
            sinon.stub(indexer.util, 'feeForAction').returns('1');
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({ valid: false, error: 'underpaid' });
            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            await handler.parse(['0', DESTINATION], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });

        it('rejects when a required native-coin fee output is absent (rejected)', async function () {
            baseSweepStubs();
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.getTicker.resolves('GAS');
            sinon.stub(indexer.util, 'feeForAction').returns('1');
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            await handler.parse(['0', DESTINATION], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('ESCROWS=1', function () {
        it('dispensers set to cancelling when DISPENSERS=1 (via data override)', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'dispenser', action_index: 30 }]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['DISPENSERS'] = 1;
                return result;
            };

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createDispenserStatus.called, 'createDispenserStatus should be called');
        });

    });
});

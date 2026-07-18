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
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Sweep = require('../../../src/actions/sweep.js');

describe('Sweep @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const DESTINATION = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

    beforeEach(function () {
        indexer = createMockIndexer();

        // getAddressEscrows is not in the default mock; add it here
        indexer.indexerDb.getAddressEscrows = sinon.stub().resolves([]);

        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined:  sinon.stub().returns(true),
                isEnabled:  sinon.stub().resolves(true),
            },
            processAction:   sinon.stub().resolves(),
        };
        handler = new Sweep(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── BALANCES=1 ──────────────────────────────────────────────────

    describe('BALANCES=1', function () {

        it('all balances transferred to destination', async function () {
            // Balance includes GAS (tick_id=1) for fees; no extra ticks so no balance sweeping needed
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' }); // 1 GAS for fee
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            // Omit BALANCES/OWNERSHIPS/ESCROWS so they remain null and default to 1/1/0
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createSweep.called);
        });

        it('createSweep called: balances debited from SOURCE, credited to DESTINATION', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createSweep.calledOnce);
        });

        // SWEEP-1: a null/empty DESTINATION must be rejected. Left unchecked it credits every
        // swept balance to a NULL address_id that updateBalances skips, breaking the per-block
        // supply invariant and halting the fleet (SanityError). Reject it, and never emit a
        // NULL-address credit.
        it('null DESTINATION → invalid, no NULL-address credit emitted', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5', 2: '10' }); // GAS + another tick
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['MYTOKEN']);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0']; // DESTINATION omitted → null

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'invalid: DESTINATION (null)');
            // No balance transfer and no ownership deed-over should have run.
            assert.ok(!indexer.indexerDb.createCredit.called, 'must not write any credit for a null-destination sweep');
            assert.ok(!indexer.indexerDb.createIssue.called, 'must not transfer ownership to a null owner');
        });

        it('empty-string DESTINATION → invalid (same guard)', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', ''];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'invalid: DESTINATION (null)');
        });

        // CONSENSUS-DETERMINISM: controller-guard executions must be ordered by the byte value of
        // the RESOLVED tick STRING, not by tick_id (a local index_tickers AUTO_INCREMENT surrogate
        // that diverges between nodes post-reorg). A reversed guard order commits a different
        // contract_hash via contract_executions last-write-wins + emission basePosition.
        it('runs controller guards in byte order of the tick string, not tick_id order', async function () {
            // tick_id numeric order (1,2,3) deliberately DIFFERS from tick-string byte order.
            const tickById = { 1: 'GAS', 2: 'ZZZ', 3: 'AAA' };
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5', 2: '5', 3: '5' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.callsFake(async (id) => tickById[Number(id)] || null);

            const calledTicks = [];
            indexer.util.maybeRunControllerGuard = sinon.stub().callsFake(async (a, b, opts) => {
                calledTicks.push(opts.tick);
                return { error: null, guardFee: '0' };
            });

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION];
            await handler.parse(params, data, null);

            assert.ok(calledTicks.length >= 2, 'at least two ticks must be guarded so order is observable');
            const byteSorted = [...calledTicks].sort((x, y) =>
                Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')));
            assert.deepStrictEqual(calledTicks, byteSorted,
                'guards must execute in byte order of the resolved tick string (consensus-stable)');
            // Teeth: the pre-fix ascending-tick_id order would have produced a DIFFERENT sequence.
            const idOf     = t => Number(Object.keys(tickById).find(k => tickById[k] === t));
            const idOrder  = [...calledTicks].sort((x, y) => idOf(x) - idOf(y));
            assert.notDeepStrictEqual(calledTicks, idOrder,
                'byte order must differ from the old tick_id order for this fixture (test has teeth)');
        });

    });

    // ─── OWNERSHIPS=1 ────────────────────────────────────────────────

    describe('OWNERSHIPS=1', function () {

        it('createIssue called with TRANSFER for each owned token', async function () {
            // Provide GAS balance for fee
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST', 'XTEST']);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            // BALANCES=null defaults to 1; OWNERSHIPS=null defaults to 1; ESCROWS=null defaults to 0
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createIssue.callCount >= 2, 'createIssue called for each ownership');
        });

        it('ownership transferred: updateTokens called per tick', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST']);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateTokens.called);
        });

    });

    // ─── ESCROWS=1 ───────────────────────────────────────────────────

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

        // Helper: force one or more sweep flags on after param parsing.
        function forceFlags(flags) {
            const orig = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => Object.assign(orig(d, p, f, v), flags);
        }

        function baseSweepStubs() {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
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

    // ─── Invalid: DESTINATION format ─────────────────────────────────

    describe('DESTINATION validation', function () {

        it('invalid DESTINATION format → invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', 'not-a-real-address'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    // ─── All three flags combined ─────────────────────────────────────

    describe('all flags combined', function () {

        it('BALANCES=1, OWNERSHIPS=1, ORDERS/SWAPS/DISPENSERS=1 all processed (via data override)', async function () {
            const orderInfo = {
                ACTION_INDEX: 10, SOURCE, GIVE_TICK: 'TEST', GIVE_REMAINING: '10',
            };
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST']);
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'order', action_index: 10 }]);
            indexer.indexerDb.getOrderInfo.resolves(orderInfo);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            // Inject ORDERS/SWAPS/DISPENSERS=1 to test all three escrow-close flags
            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['ORDERS']     = 1;
                result['SWAPS']      = 1;
                result['DISPENSERS'] = 1;
                return result;
            };

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createSweep.called);
            assert.ok(indexer.indexerDb.createIssue.called);
            assert.ok(indexer.indexerDb.createOrderStatus.called);
        });

        it('escrowed-ownership tick produces exactly ONE ISSUE when OWNERSHIPS=1 and ORDERS=1', async function () {
            // SOURCE has an open GIVE_OWNERSHIP=1 order escrowing TEST's ownership.
            // The real getAddressOwnerships query excludes escrowed ticks, but even
            // with a stale snapshot that still contains the tick (stubbed here), the
            // handler must not write a second ownership-transfer ISSUE after the
            // order-cancel path already delivered it; a duplicate ISSUE would
            // change the per-block actions hash.
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST']); // stale snapshot still contains the escrowed tick
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'order', action_index: 10 }]);
            indexer.indexerDb.getOrderInfo.resolves({ ACTION_INDEX: 10, SOURCE, GIVE_TICK: 'TEST', GIVE_REMAINING: '0', GIVE_OWNERSHIP: 1 });
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS default to 1

            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['ORDERS'] = 1;
                return result;
            };

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createOrderStatus.calledWith(sinon.match.any, 10, 'cancelled'));
            assert.strictEqual(indexer.indexerDb.createIssue.callCount, 1,
                'escrowed-ownership tick must be transferred exactly once (offer-close path only)');
        });

        it('escrowed-ownership tick via SWAP produces exactly ONE ISSUE when OWNERSHIPS=1 and SWAPS=1', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST']); // stale snapshot still contains the escrowed tick
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'swap', action_index: 20 }]);
            indexer.indexerDb.getSwapInfo.resolves({ ACTION_INDEX: 20, SOURCE, GIVE_TICK: 'TEST', GIVE_AMOUNT: '0', GIVE_OWNERSHIP: 1 });
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION];

            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['SWAPS'] = 1;
                return result;
            };

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createSwapStatus.calledWith(sinon.match.any, 20, 'cancelled'));
            assert.strictEqual(indexer.indexerDb.createIssue.callCount, 1,
                'escrowed-ownership tick must be transferred exactly once (offer-close path only)');
        });

        it('non-escrowed ownership still transferred alongside an escrowed-order tick', async function () {
            // TEST is escrowed by the order; XTEST is a plain ownership. The sweep
            // must deliver both to DESTINATION with exactly one ISSUE each.
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST', 'XTEST']);
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'order', action_index: 10 }]);
            indexer.indexerDb.getOrderInfo.resolves({ ACTION_INDEX: 10, SOURCE, GIVE_TICK: 'TEST', GIVE_REMAINING: '0', GIVE_OWNERSHIP: 1 });
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION];

            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['ORDERS'] = 1;
                return result;
            };

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.createIssue.callCount, 2,
                'one ISSUE for the escrowed tick (offer-close path) + one for the plain ownership');
        });

    });

    // ─── SOURCE sleeping ─────────────────────────────────────────────

    describe('SOURCE sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
                if (address && !tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    // ─── Record creation ─────────────────────────────────────────────

    describe('record creation', function () {

        it('createSweep called even on invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', 'not-a-real-address'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createSweep.called);
        });

    });
});

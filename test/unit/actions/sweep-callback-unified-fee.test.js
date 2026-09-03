/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/actions/sweep-callback-unified-fee.test.js
 *
 * SWEEP and CALLBACK on the unified gas schedule, and the flag day
 * that gates the move.
 *
 * THE DEFECT. Both actions priced their protocol fee with the legacy model:
 * getTransactionFee(db_hits), a flat 1000 satoshis of XCHAIN per database hit and
 * no floor under it. On BTC that is only cheap, because detectFeePaymentMode
 * falls back to an XCHAIN-balance debit when no native fee output is present. On
 * LTC and DOGE it is FATAL: there the missing output is rejected outright, so the
 * fee has to be payable as a real native-coin output, and a fee below the chain's
 * dust threshold cannot be paid at all. A Litecoin SWEEP was measured quoting 600
 * litoshi against a 5460-satoshi dust floor - not expensive, unsubmittable, and it
 * reproduces on mainnet Litecoin.
 *
 * WHAT THESE TESTS PIN.
 *   - the arithmetic of both unified prices (base + per-item), which is a
 *     consensus-visible ledger amount;
 *   - the DUST property that is the whole point: the unified price of the
 *     SMALLEST possible SWEEP clears Litecoin's dust threshold at a realistic
 *     LTC price, and the legacy price of the same sweep does not. This is the
 *     assertion that fails if someone later re-prices SWEEP_BASE down;
 *   - that BELOW the flag day both handlers still take the legacy branch
 *     byte-for-byte, because fees.AMOUNT is hashed into balances_root/ledger_hash
 *     and a from-genesis replay has to reproduce it;
 *   - that the gas-schedule keys resolve STRICTLY, so a bundle missing one halts
 *     instead of pricing at a phantom default and forking.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Sweep    = require('../../../src/actions/sweep.js');
const Callback = require('../../../src/actions/callback.js');
const coins    = require('../../../src/coins');

const GATE = 'UNIFIED_FEES_SWEEP_CALLBACK';

const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const HOLDER1     = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
const HOLDER2     = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';

describe('SWEEP / CALLBACK unified gas-schedule fee @regression @tier3', function () {
    let indexer, actionsCtx, feeSpy, legacyStub;

    beforeEach(function () {
        indexer = createMockIndexer();
        // getAddressEscrows is not in the shared mock-db surface; the sibling suites
        // attach it the same way.
        indexer.indexerDb.getAddressEscrows = sinon.stub().resolves([]);
        indexer.indexerDb.getAddressOwnerships.resolves([]);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getList.resolves([]);
        indexer.indexerDb.getTicker.resolves('XCHAIN');
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction:   sinon.stub().resolves(),
        };
        // feeForAction receives the fully computed per-tx fee from BOTH branches, so one
        // spy reads the priced amount whichever branch ran.
        feeSpy     = sinon.spy(indexer.util, 'feeForAction');
        legacyStub = sinon.spy(indexer.util, 'getTransactionFee');
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // The unified price, expressed the way the coin bundle expresses it, so the test
    // reads the schedule rather than restating a literal that could drift from it.
    function expectedFee(baseKey, perItemKey, items) {
        const s = indexer.config['GAS_SCHEDULE'];
        const gas = s[baseKey] + (items * s[perItemKey]);
        return { gas, fee: indexer.util.bcmul(gas, indexer.config['GAS_PRICE'], 8) };
    }

    function pricedFee() {
        assert.ok(feeSpy.called, 'feeForAction was never called: no fee was priced');
        return String(feeSpy.firstCall.args[0]);
    }

    async function runSweep(params, opts = {}) {
        indexer.indexerDb.getAddressBalances.resolves(opts.balances || { 1: '1000' });
        const handler = new Sweep(actionsCtx);
        const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
        await handler.parse(params, data, null);
        return data;
    }

    async function runCallback(opts = {}) {
        const tokenInfo = createTokenInfo({
            TICK: 'TEST', TICK_ID: 1, OWNER: SOURCE, DECIMALS: 0,
            LOCK_CALLBACK: 0, CALLBACK_BLOCK: 90, CALLBACK_TICK: 'CBTEST', CALLBACK_AMOUNT: '1',
        });
        const cbTokenInfo = createTokenInfo({ TICK: 'CBTEST', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });
        indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
        indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
        indexer.indexerDb.getHolders.resolves(opts.holders || { [HOLDER1]: '10', [HOLDER2]: '20' });
        const handler = new Callback(actionsCtx);
        const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
        await handler.parse(['0', 'TEST', 'memo'], data, null);
        return data;
    }

    describe('at or above the flag day', function () {

        it('SWEEP prices SWEEP_BASE + items * SWEEP_PER_ITEM and never touches the legacy model', async function () {
            const data = await runSweep(['0', DESTINATION], { balances: { 1: '1000' } });
            assert.strictEqual(data['STATUS'], 'valid');
            // One swept balance, no escrows, no ownerships.
            const { fee } = expectedFee('SWEEP_BASE', 'SWEEP_PER_ITEM', 1);
            assert.strictEqual(pricedFee(), String(fee));
            assert.strictEqual(legacyStub.called, false, 'the legacy db-hits model was still consulted');
        });

        it('SWEEP counts one item per swept balance', async function () {
            await runSweep(['0', DESTINATION], { balances: { 1: '1000', 2: '5', 3: '7' } });
            const { fee } = expectedFee('SWEEP_BASE', 'SWEEP_PER_ITEM', 3);
            assert.strictEqual(pricedFee(), String(fee));
        });

        it('SWEEP counts one item per swept ownership and per closed escrow', async function () {
            indexer.indexerDb.getAddressOwnerships.resolves(['OWNED1', 'OWNED2']);
            indexer.indexerDb.getAddressEscrows.resolves([
                { type: 'order', action_index: 11 },
                { type: 'swap',  action_index: 12 },
            ]);
            indexer.indexerDb.getOrderInfo.resolves({ ACTION_INDEX: 11, SOURCE, GIVE_TICK: 'TEST', GIVE_REMAINING: '1', GIVE_OWNERSHIP: 0 });
            indexer.indexerDb.getSwapInfo.resolves({ ACTION_INDEX: 12, SOURCE, GIVE_TICK: 'TEST', GIVE_AMOUNT: '1', GIVE_OWNERSHIP: 0 });
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
            // BALANCES=1, OWNERSHIPS=1, ORDERS=1, SWAPS=1, DISPENSERS=0
            await runSweep(['0', DESTINATION, 1, 1, 1, 1, 0], { balances: { 1: '1000' } });
            // 1 balance + 2 escrows + 2 ownerships
            const { fee } = expectedFee('SWEEP_BASE', 'SWEEP_PER_ITEM', 5);
            assert.strictEqual(pricedFee(), String(fee));
        });

        it('SWEEP charges the BASE even when the flags exclude every item', async function () {
            // BALANCES=0, OWNERSHIPS=0 and no escrows: the smallest SWEEP there is. It is
            // exactly this case the legacy model priced at a few hundred satoshis.
            await runSweep(['0', DESTINATION, 0, 0, 0, 0, 0], { balances: { 1: '1000' } });
            const { fee } = expectedFee('SWEEP_BASE', 'SWEEP_PER_ITEM', 0);
            assert.strictEqual(pricedFee(), String(fee));
        });

        it('CALLBACK prices CALLBACK_BASE + recipients * CALLBACK_PER_RECIPIENT', async function () {
            const data = await runCallback();
            assert.strictEqual(data['STATUS'], 'valid');
            const { fee } = expectedFee('CALLBACK_BASE', 'CALLBACK_PER_RECIPIENT', 2);
            assert.strictEqual(pricedFee(), String(fee));
            assert.strictEqual(legacyStub.called, false, 'the legacy db-hits model was still consulted');
        });

        it('CALLBACK charges the BASE with no recipients at all', async function () {
            await runCallback({ holders: {} });
            const { fee } = expectedFee('CALLBACK_BASE', 'CALLBACK_PER_RECIPIENT', 0);
            assert.strictEqual(pricedFee(), String(fee));
        });

        it('an emitted (VM-synthesized) SWEEP still pays no per-tx fee', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            const handler = new Sweep(actionsCtx);
            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE, IS_EMISSION: 1 });
            await handler.parse(['0', DESTINATION], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(String(feeSpy.firstCall.returnValue), '0');
        });
    });

    describe('below the flag day', function () {

        beforeEach(function () {
            actionsCtx.protocolChanges.isEnabled.withArgs(GATE).resolves(false);
        });

        it('SWEEP falls back to the legacy db-hits model unchanged', async function () {
            await runSweep(['0', DESTINATION], { balances: { 1: '1000' } });
            assert.ok(legacyStub.called, 'the legacy db-hits model was not used below the flag day');
            // 1 sweep row + 1 balance * 4
            assert.strictEqual(legacyStub.firstCall.args[0], 5);
            assert.strictEqual(pricedFee(), String(indexer.util.getTransactionFee(5)));
        });

        it('CALLBACK falls back to the legacy db-hits model unchanged', async function () {
            await runCallback();
            assert.ok(legacyStub.called, 'the legacy db-hits model was not used below the flag day');
            // 4 base + 2 recipients * 3
            assert.strictEqual(legacyStub.firstCall.args[0], 10);
            assert.strictEqual(pricedFee(), String(indexer.util.getTransactionFee(10)));
        });
    });

    describe('the dust property this change exists for', function () {

        // A native-fee chain can only carry a protocol fee as a real output, so the fee
        // has to be worth at least the chain's dust threshold. The conversion is
        // computeNativeFeeBand, the SAME function validateNativeCoinFee uses to decide
        // whether a submitted fee output is acceptable and computeFeeQuote uses to tell a
        // wallet how large to make it - called here rather than restated, so the test
        // cannot agree with itself while disagreeing with the consensus check.
        function nativeSats(xchainFee, coinUsd, xchainUsd) {
            const band = indexer.util.computeNativeFeeBand(
                String(xchainFee), String(xchainUsd), String(coinUsd),
                indexer.config['FEE_TOLERANCE_MIN'], indexer.config['FEE_TOLERANCE_MAX']);
            return Number(indexer.util.bcmul(band.expectedNative, '100000000', 0));
        }

        // Litecoin's own pinned dust threshold, read from the coin bundle rather than
        // restated, so a change to it moves this test with it.
        const LTC_DUST = coins.getCoinConfig('LTC', 'mainnet').net.dustThreshold;

        it('the exact SWEEP the wallet refused now clears dust at the venue price', async function () {
            // The measured refusal: a Litecoin SWEEP quoted 0.00000600 LTC (600 litoshi)
            // against the 5460 floor, at the regtest venue's seeded LTC $30 / XCHAIN $2.
            // Same sweep, same prices, unified price.
            const { fee } = expectedFee('SWEEP_BASE', 'SWEEP_PER_ITEM', 1);
            const sats = nativeSats(fee, 30, 2);
            assert.ok(sats >= LTC_DUST,
                'the sweep the wallet refused still prices at ' + sats + ' litoshi, under ' + LTC_DUST);
        });

        it('the smallest unified SWEEP clears Litecoin dust at LTC $100 / XCHAIN $2', async function () {
            const { fee } = expectedFee('SWEEP_BASE', 'SWEEP_PER_ITEM', 0);
            assert.ok(nativeSats(fee, 100, 2) >= LTC_DUST,
                'the minimum SWEEP fee (' + fee + ' XCHAIN) buys ' + nativeSats(fee, 100, 2) +
                ' litoshi, under the ' + LTC_DUST + ' dust floor: the fee output cannot be created');
        });

        it('the smallest unified CALLBACK clears Litecoin dust at LTC $100 / XCHAIN $2', async function () {
            const { fee } = expectedFee('CALLBACK_BASE', 'CALLBACK_PER_RECIPIENT', 0);
            assert.ok(nativeSats(fee, 100, 2) >= LTC_DUST);
        });

        it('the legacy price of that same SWEEP does NOT clear it, which is the defect', async function () {
            // 5 db hits: the minimal one-balance SWEEP the legacy branch prices above.
            const legacyFee = indexer.util.getTransactionFee(5);
            assert.ok(nativeSats(legacyFee, 100, 2) < LTC_DUST,
                'the legacy fee now clears dust; this test no longer describes the defect');
        });

        it('the unified SWEEP still clears dust across a wide LTC/XCHAIN price band', async function () {
            const { fee } = expectedFee('SWEEP_BASE', 'SWEEP_PER_ITEM', 0);
            // COIN/XCHAIN ratios well past anything the pair has traded at.
            for (const [coinUsd, xchainUsd] of [[100, 2], [500, 2], [1000, 2], [100, 0.5]]) {
                assert.ok(nativeSats(fee, coinUsd, xchainUsd) >= LTC_DUST,
                    'under dust at LTC $' + coinUsd + ' / XCHAIN $' + xchainUsd);
            }
        });
    });

    describe('gas-schedule keys resolve strictly', function () {

        it('every key this change introduces is present in all three coin bundles', function () {
            for (const tick of ['BTC', 'LTC', 'DOGE']) {
                for (const network of ['mainnet', 'testnet', 'regtest']) {
                    const schedule = coins.getCoinConfig(tick, network).GAS_SCHEDULE;
                    for (const key of ['SWEEP_BASE', 'SWEEP_PER_ITEM', 'CALLBACK_BASE', 'CALLBACK_PER_RECIPIENT']) {
                        assert.ok(Number.isInteger(schedule[key]) && schedule[key] >= 0,
                            tick + ':' + network + ' GAS_SCHEDULE.' + key + ' is ' + JSON.stringify(schedule[key]));
                    }
                }
            }
        });

        it('a missing or malformed key throws rather than pricing at a phantom default', function () {
            const util = indexer.util;
            const saved = util.config['GAS_SCHEDULE'];
            try {
                util.config['GAS_SCHEDULE'] = Object.assign({}, saved, { SWEEP_BASE: undefined });
                assert.throws(() => util.resolveGasScheduleCost('SWEEP_BASE'), /SWEEP_BASE missing or invalid/);
                util.config['GAS_SCHEDULE'] = Object.assign({}, saved, { SWEEP_BASE: '5000abc' });
                assert.throws(() => util.resolveGasScheduleCost('SWEEP_BASE'), /SWEEP_BASE missing or invalid/);
                util.config['GAS_SCHEDULE'] = Object.assign({}, saved, { SWEEP_BASE: -1 });
                assert.throws(() => util.resolveGasScheduleCost('SWEEP_BASE'), /SWEEP_BASE missing or invalid/);
            } finally {
                util.config['GAS_SCHEDULE'] = saved;
            }
        });
    });
});

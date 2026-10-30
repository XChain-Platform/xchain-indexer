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
process.env.INDEXER_NETWORK = 'mainnet';

const assert = require('assert');
const sinon = require('sinon');
const Utility = require('../../../../../src/utility.js');
const { stubGate } = require('../../../../helpers/gate_modules.js');
const { nativeFeeAirdrop } = require('./helpers/native_fee_legs.js');

const PARAMS = ['2', 'TEST', '10', '1', 'TEST', '10', '1', null];
// Three legs whose middle LIST holds two recipients, so it costs twice a single leg.
const THREE_LEG_PARAMS = ['2', 'TEST', '10', '1', 'TEST', '10', '2', 'TEST', '10', '3', null];
const ROLLBACK_GATE =
    'airdrop_native_fee_tally_rollback_activation.AIRDROP_NATIVE_FEE_TALLY_ROLLBACK_ACTIVATION';

async function outcomeFor(nativeFeeValue, opts = {}) {
    const { indexer, handler, data } = nativeFeeAirdrop({ nativeFeeValue });
    indexer.config['NETWORK'] = 'regtest';
    data['NETWORK'] = 'regtest';
    if(opts.xchain)
        data['TX_OUTPUTS'] = [];
    if(opts.batch)
        data['BATCH_VALUE_LEDGER'] = {
            nativeFeeConsumed: '0',
            coinAmountConsumed: '0',
            oracleFeeConsumed: {},
        };
    if(opts.probe)
        data['FEE_PROBE'] = true;
    if(opts.middleCostsTwoLegs)
        indexer.indexerDb.getList.callsFake(async list => Number(list) === 2
            ? ['middle-recipient-a', 'middle-recipient-b']
            : ['single-recipient']);
    if(Object.prototype.hasOwnProperty.call(opts, 'rollback'))
        stubGate(sinon, ROLLBACK_GATE, opts.rollback);

    const statuses = [];
    const feeRecords = [];
    indexer.indexerDb.createAirdrop.callsFake(async airdrop => statuses.push(airdrop['STATUS']));
    indexer.indexerDb.createFeeRecord.callsFake(async fees => feeRecords.push({
        amount: indexer.util.bcformat(fees['AMOUNT'], 8),
        gasCost: indexer.util.bcformat(fees['GAS_COST'], 0),
        xchainAmount: fees['XCHAIN_AMOUNT'] === undefined ? null : indexer.util.bcformat(fees['XCHAIN_AMOUNT'], 8),
        nativeCoinAmount: String(fees['NATIVE_COIN_AMOUNT']),
        tallyConsumed: fees['NATIVE_FEE_LEDGER'] && fees['NATIVE_FEE_LEDGER'].nativeFeeConsumed,
    }));
    const ledger = sinon.spy(indexer.util, 'processTransactionLedgerChanges');

    assert.strictEqual(indexer.util.validateNativeCoinFee, Utility.prototype.validateNativeCoinFee);
    await handler.parse(opts.params || PARAMS, data, null);
    const gasTick = indexer.config['GAS'];
    const feeDebits = ledger.calledOnce
        ? ledger.firstCall.args[3].filter(row => row[0] === gasTick).map(row => indexer.util.bcformat(row[1], 8))
        : null;
    return { statuses, feeRecords, feeDebits, batchLedger: data['BATCH_VALUE_LEDGER'] };
}

// Assert every leg is valid and debits its own fee, while the action's last fees row (written
// after each leg's own row) records the summed fee, gas and XCHAIN amount.
function assertSummedXchainFeeRow(outcome, legDebits, amount, gasCost) {
    assert.deepStrictEqual(outcome.statuses, legDebits.map(() => 'valid'));
    assert.deepStrictEqual(outcome.feeDebits, legDebits);
    assert.strictEqual(outcome.feeRecords.length, legDebits.length + 1);
    const row = outcome.feeRecords[legDebits.length];
    assert.deepStrictEqual([row.amount, row.gasCost, row.xchainAmount], [amount, gasCost, amount]);
}

describe('Airdrop multi-leg native fee action tally @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('draws one non-BATCH native output across the legs and records their summed fee', async function () {
        const outcome = await outcomeFor('0.02000000');
        assert.deepStrictEqual(outcome.statuses, ['valid', 'valid']);
        assert.deepStrictEqual(outcome.feeRecords.map(row => row.amount), ['0.00100000', '0.00200000']);
        assert.strictEqual(outcome.feeRecords[1].gasCost, '200');
        assert.strictEqual(outcome.feeRecords[1].nativeCoinAmount, '0.02000000');
        assert.strictEqual(outcome.feeRecords[1].tallyConsumed, '0.02000000');
    });

    it('rejects the unpaid second non-BATCH leg after the first leg draws the output', async function () {
        const outcome = await outcomeFor('0.01000000');
        assert.deepStrictEqual(outcome.statuses, ['valid', 'invalid: fee output has zero value']);
        assert.deepStrictEqual(outcome.feeRecords.map(row => row.amount), ['0.00100000']);
    });

    it('drops a failed middle leg\'s fee and gas from the AIRDROP_NATIVE_FEE_TALLY_ROLLBACK_ACTIVATION tally', async function () {
        const options = { params: THREE_LEG_PARAMS, middleCostsTwoLegs: true };
        const above = await outcomeFor('0.02000000', Object.assign({ rollback: true }, options));
        assert.strictEqual(above.statuses[0], 'valid');
        assert.match(above.statuses[1], /^invalid: insufficient native coin fee /);
        assert.strictEqual(above.statuses[2], 'valid');
        assert.deepStrictEqual(above.feeRecords.map(row => row.amount), ['0.00100000', '0.00200000']);
        assert.deepStrictEqual(above.feeRecords.map(row => row.gasCost), ['100', '200']);
    });

    it('keeps a failed middle leg\'s fee and gas in the tally below the rollback gate', async function () {
        const options = { params: THREE_LEG_PARAMS, middleCostsTwoLegs: true };
        const below = await outcomeFor('0.02000000', Object.assign({ rollback: false }, options));
        assert.strictEqual(below.statuses[0], 'valid');
        assert.match(below.statuses[1], /^invalid: insufficient native coin fee /);
        assert.strictEqual(below.statuses[2], 'valid');
        assert.deepStrictEqual(below.feeRecords.map(row => row.amount), ['0.00100000', '0.00400000']);
        assert.deepStrictEqual(below.feeRecords.map(row => row.gasCost), ['100', '400']);
    });

    it('makes a FEE_PROBE quote the summed fee without drawing the action tally', async function () {
        const outcome = await outcomeFor('0.01000000', { probe: true });
        assert.deepStrictEqual(outcome.statuses, ['valid', 'valid']);
        assert.strictEqual(outcome.feeRecords[1].amount, '0.00200000');
        assert.strictEqual(outcome.feeRecords[1].tallyConsumed, '0');
    });

    it('leaves a BATCH_VALUE_LEDGER on the existing per-leg path at the gate height', async function () {
        const outcome = await outcomeFor('0.02000000', { batch: true });
        assert.deepStrictEqual(outcome.statuses, ['valid', 'valid']);
        assert.deepStrictEqual(outcome.feeRecords.map(row => row.amount), ['0.00100000', '0.00100000']);
        assert.strictEqual(outcome.batchLedger.nativeFeeConsumed, '0.02000000');
    });

    it('leaves XCHAIN-balance fee settlement on the existing per-leg path', async function () {
        const wide = { xchain: true, params: THREE_LEG_PARAMS, middleCostsTwoLegs: true };
        assertSummedXchainFeeRow(await outcomeFor('0.02000000', { xchain: true }), ['0.00100000', '0.00100000'], '0.00200000', '200');
        assertSummedXchainFeeRow(await outcomeFor('0.02000000', wide), ['0.00100000', '0.00200000', '0.00100000'], '0.00400000', '400');
    });
});

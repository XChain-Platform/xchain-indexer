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
const { nativeFeeAirdrop } = require('./helpers/native_fee_legs.js');

const PARAMS = ['2', 'TEST', '10', '1', 'TEST', '10', '1', null];

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

    const statuses = [];
    const feeRecords = [];
    indexer.indexerDb.createAirdrop.callsFake(async airdrop => statuses.push(airdrop['STATUS']));
    indexer.indexerDb.createFeeRecord.callsFake(async fees => feeRecords.push({
        amount: indexer.util.bcformat(fees['AMOUNT'], 8),
        gasCost: indexer.util.bcformat(fees['GAS_COST'], 0),
        nativeCoinAmount: String(fees['NATIVE_COIN_AMOUNT']),
        tallyConsumed: fees['NATIVE_FEE_LEDGER'] && fees['NATIVE_FEE_LEDGER'].nativeFeeConsumed,
    }));

    assert.strictEqual(indexer.util.validateNativeCoinFee, Utility.prototype.validateNativeCoinFee);
    await handler.parse(PARAMS, data, null);
    return { statuses, feeRecords, batchLedger: data['BATCH_VALUE_LEDGER'] };
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
        const outcome = await outcomeFor('0.02000000', { xchain: true });
        assert.deepStrictEqual(outcome.statuses, ['valid', 'valid']);
        assert.deepStrictEqual(outcome.feeRecords.map(row => row.amount), ['0.00100000', '0.00100000']);
    });
});

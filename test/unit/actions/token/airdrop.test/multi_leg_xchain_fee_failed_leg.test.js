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
const { nativeFeeAirdrop } = require('./helpers/native_fee_legs.js');

// Three legs whose middle LIST holds two recipients, so it costs twice a single leg.
const THREE_LEG_PARAMS = ['2', 'TEST', '10', '1', 'TEST', '10', '2', 'TEST', '10', '3', null];

// Run the three-leg AIRDROP in XCHAIN-balance mode with SOURCE holding `gasBalance` of the fee tick.
async function xchainOutcome(gasBalance) {
    const { indexer, handler, data } = nativeFeeAirdrop({ nativeFeeValue: '0' });
    indexer.config['NETWORK'] = 'regtest';
    data['NETWORK'] = 'regtest';
    data['TX_OUTPUTS'] = [];
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000', 9: gasBalance });
    indexer.indexerDb.getList.callsFake(async list => Number(list) === 2
        ? ['middle-recipient-a', 'middle-recipient-b']
        : ['single-recipient']);

    const statuses = [];
    const feeRecords = [];
    indexer.indexerDb.createAirdrop.callsFake(async airdrop => statuses.push(airdrop['STATUS']));
    indexer.indexerDb.createFeeRecord.callsFake(async fees => feeRecords.push([
        indexer.util.bcformat(fees['AMOUNT'], 8), indexer.util.bcformat(fees['GAS_COST'], 0),
    ]));
    const ledger = sinon.spy(indexer.util, 'processTransactionLedgerChanges');

    await handler.parse(THREE_LEG_PARAMS, data, null);
    const gasTick = indexer.config['GAS'];
    const feeDebits = ledger.firstCall.args[3]
        .filter(row => row[0] === gasTick).map(row => indexer.util.bcformat(row[1], 8));
    return { statuses, feeRecords, feeDebits };
}

describe('Airdrop multi-leg XCHAIN-balance fee row with a failed leg @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('sums only the valid legs into the fees row when the middle leg cannot pay its fee', async function () {
        const outcome = await xchainOutcome('0.00250000');
        assert.deepStrictEqual(outcome.statuses, ['valid', 'invalid: insufficient funds (FEE)', 'valid']);
        assert.deepStrictEqual(outcome.feeDebits, ['0.00100000', '0.00100000']);
        assert.deepStrictEqual(outcome.feeRecords, [['0.00100000', '100'], ['0.00100000', '100'], ['0.00200000', '200']]);
    });

    it('keeps the single valid leg\'s own fees row when the other legs cannot pay', async function () {
        const outcome = await xchainOutcome('0.00150000');
        assert.deepStrictEqual(outcome.statuses,
            ['valid', 'invalid: insufficient funds (FEE)', 'invalid: insufficient funds (FEE)']);
        assert.deepStrictEqual(outcome.feeDebits, ['0.00100000']);
        assert.deepStrictEqual(outcome.feeRecords, [['0.00100000', '100']]);
    });
});

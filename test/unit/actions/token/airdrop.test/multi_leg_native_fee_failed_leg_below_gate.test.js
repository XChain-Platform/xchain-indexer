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
process.env.INDEXER_NETWORK = 'testnet';

const assert = require('assert');
const sinon = require('sinon');
const { nativeFeeAirdrop } = require('./helpers/native_fee_legs.js');

const PARAMS = ['2', 'TEST', '10', '1', 'TEST', '10', '1', null];

async function outcomeAt(blockIndex) {
    const { indexer, handler, data } = nativeFeeAirdrop({ nativeFeeValue: '0.02000000' });
    indexer.config['NETWORK'] = 'testnet';
    data['NETWORK'] = 'testnet';
    data['BLOCK_INDEX'] = blockIndex;

    const validate = sinon.stub(indexer.util, 'validateNativeCoinFee');
    validate.onFirstCall().resolves({ valid: false, error: 'insufficient native coin fee' });
    validate.resolves({ valid: true, nativeCoinAmount: '0.01000000', nativeCoin: 'BTC', oracleRound: 7 });

    const statuses = [];
    const feeRecords = [];
    indexer.indexerDb.createAirdrop.callsFake(async airdrop => statuses.push(airdrop['STATUS']));
    indexer.indexerDb.createFeeRecord.callsFake(async fees => feeRecords.push({
        amount: indexer.util.bcformat(fees['AMOUNT'], 8),
        gasCost: indexer.util.bcformat(fees['GAS_COST'], 0),
    }));

    await handler.parse(PARAMS, data, null);
    return { statuses, feeRecords };
}

describe('Airdrop multi-leg native fee failed leg on testnet @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('keeps the failed leg increment in the tally at the tally gate height', async function () {
        const outcome = await outcomeAt(157073);
        assert.deepStrictEqual(outcome.statuses, ['invalid: insufficient native coin fee', 'valid']);
        assert.strictEqual(outcome.feeRecords.length, 1);
        assert.strictEqual(outcome.feeRecords[0].amount, '0.00200000');
        assert.strictEqual(outcome.feeRecords[0].gasCost, '200');
    });

    it('charges only the surviving leg below the tally gate height', async function () {
        const outcome = await outcomeAt(157072);
        assert.deepStrictEqual(outcome.statuses, ['invalid: insufficient native coin fee', 'valid']);
        assert.strictEqual(outcome.feeRecords.length, 1);
        assert.strictEqual(outcome.feeRecords[0].amount, '0.00100000');
        assert.strictEqual(outcome.feeRecords[0].gasCost, '100');
    });
});

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

async function outcomeFor(nativeFeeValue, feeProbe = false) {
    const { indexer, handler, data } = nativeFeeAirdrop({ nativeFeeValue });
    data['BATCH_VALUE_LEDGER'] = {
        nativeFeeConsumed: '0',
        coinAmountConsumed: '0',
        oracleFeeConsumed: {},
    };
    if(feeProbe)
        data['FEE_PROBE'] = true;

    const statuses = [];
    indexer.indexerDb.createAirdrop.callsFake(async airdrop => statuses.push(airdrop['STATUS']));

    assert.strictEqual(indexer.util.validateNativeCoinFee, Utility.prototype.validateNativeCoinFee);
    await handler.parse(PARAMS, data, null);
    return { statuses, nativeFeeConsumed: data['BATCH_VALUE_LEDGER'].nativeFeeConsumed };
}

describe('Airdrop multi-leg native fee batch ledger and probe @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('draws one leg fee from a BATCH_VALUE_LEDGER and rejects the unpaid second leg', async function () {
        const outcome = await outcomeFor('0.01000000');
        assert.deepStrictEqual(outcome.statuses, ['valid', 'invalid: fee output has zero value']);
        assert.strictEqual(outcome.nativeFeeConsumed, '0.01000000');
    });

    it('draws two leg fees from a fully funded BATCH_VALUE_LEDGER', async function () {
        const outcome = await outcomeFor('0.02000000');
        assert.deepStrictEqual(outcome.statuses, ['valid', 'valid']);
        assert.strictEqual(outcome.nativeFeeConsumed, '0.02000000');
    });

    it('settles both legs during a FEE_PROBE without drawing from BATCH_VALUE_LEDGER', async function () {
        const outcome = await outcomeFor('0.01000000', true);
        assert.deepStrictEqual(outcome.statuses, ['valid', 'valid']);
        assert.strictEqual(outcome.nativeFeeConsumed, '0');
    });
});

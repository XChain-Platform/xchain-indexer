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

async function statusesFor(nativeFeeValue) {
    const { indexer, handler, data } = nativeFeeAirdrop({ nativeFeeValue });
    const statuses = [];
    indexer.indexerDb.createAirdrop.callsFake(async airdrop => statuses.push(airdrop['STATUS']));

    assert.strictEqual(indexer.config['NETWORK'], 'mainnet');
    assert.strictEqual(indexer.util.validateNativeCoinFee, Utility.prototype.validateNativeCoinFee);
    await handler.parse(PARAMS, data, null);
    return statuses;
}

describe('Airdrop multi-leg native fee below cumulative gate @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('settles both FORMAT 2 non-BATCH legs valid when one native output pays one leg but not their sum', async function () {
        assert.deepStrictEqual(await statusesFor('0.01000000'), ['valid', 'valid']);
    });

    it('settles both FORMAT 2 non-BATCH legs invalid when the native output is under one leg fee', async function () {
        const statuses = await statusesFor('0.00949999');
        assert.strictEqual(statuses.length, 2);
        for(const status of statuses)
            assert.match(status, /^invalid: insufficient native coin fee /);
    });
});

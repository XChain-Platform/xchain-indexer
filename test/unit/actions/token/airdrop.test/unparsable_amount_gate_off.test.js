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
// AIRDROP with the amount representability gate off. The legacy format rule checks each side
// of the '.' alone, so amounts such as '1.+5' pass it while mathjs cannot parse them, and the
// leg's DEBIT bcmul would throw out of the block. Such a leg must settle as a format refusal,
// and every verdict reached before that point must stay as it was. Part of the AIRDROP suite;
// see ../airdrop.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const { freshAirdrop } = require('./helpers/airdrop_fixtures.js');
const amountRepresentability = require('../../../../../src/utility/validation/amount_representability_gate.js');
const normalize = require('../../../../../src/db/database/normalize.js');

const UNPARSABLE = ['1.+5', '1.-5', '1.0x5', '1e5.5'];

let indexer, handler;

// A divisible tick, a funded SOURCE and an address LIST naming `recipients`
function arrange(recipients, listType){
    indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 8, SUPPLY: '500' }));
    indexer.indexerDb.getListType.resolves(listType);
    indexer.indexerDb.getList.resolves(recipients);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.isActionAllowed.resolves(true);
}

async function airdrop(amount){
    const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
    await handler.parse(['0', 'TEST', amount, '1', null], data, null);
    return data;
}

describe('Airdrop unparsable AMOUNT with the representability gate off @regression @tier1', function () {
    beforeEach(function () {
        ({ indexer, handler } = freshAirdrop());
        sinon.stub(amountRepresentability, 'isAmountRepresentabilityActive').returns(false);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('premise: each amount passes the legacy format rule and fails bcparses', function () {
        for(const amount of UNPARSABLE){
            assert.strictEqual(indexer.util.isValidAmountFormat(8, amount, 1), true, amount);
            assert.strictEqual(indexer.util.bcparses(amount), false, amount);
        }
    });

    for(const amount of UNPARSABLE){
        it('AMOUNT ' + JSON.stringify(amount) + ' settles as a format refusal instead of throwing', async function () {
            arrange(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM'], 2);
            const data = await airdrop(amount);
            assert.strictEqual(data['STATUS'], 'invalid: AMOUNT (format)');
            assert.strictEqual(String(data['DEBIT']), '0');
        });
    }

    it('the refused row binds a NULL amount through the real writer normalizer', async function () {
        const writer = { util: indexer.util, config: indexer.util.config };
        for(const amount of UNPARSABLE){
            arrange(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM'], 2);
            await airdrop(amount);
            const row = indexer.indexerDb.createAirdrop.lastCall.args[0];
            assert.strictEqual(row['STATUS'], 'invalid: AMOUNT (format)');
            const bound = normalize.fitRefusedIntegerFields.call(writer,
                normalize.normalizeDataValues.call(writer, row), ['LIST_ACTION_INDEX']);
            assert.strictEqual(bound['AMOUNT'], null, amount);
        }
    });

    it('an unparsable AMOUNT on a LIST with no recipients settles as a format refusal', async function () {
        arrange([], 2);
        const data = await airdrop('1.+5');
        assert.strictEqual(data['STATUS'], 'invalid: AMOUNT (format)');
    });

    it('an unparsable AMOUNT on an unknown LIST keeps the LIST verdict', async function () {
        arrange([], false);
        const data = await airdrop('1.+5');
        assert.strictEqual(data['STATUS'], 'invalid: LIST (unknown)');
    });

    it('a plain AMOUNT still settles valid', async function () {
        arrange(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM'], 2);
        const data = await airdrop('10');
        assert.strictEqual(data['STATUS'], 'valid');
    });
});

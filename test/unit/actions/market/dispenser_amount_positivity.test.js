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
// Dispenser amount-positivity rules.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const {
    OWNER_ADDR, BLOCK_TIME, EXPIRATION,
    makeDispenser, freshDispenserCreateSuite,
} = require('./dispenser_amount_positivity.test/helpers/dispenser_amount_positivity_suite.js');

let indexer, dispenser;

function freshCreateSuite() {
    ({ indexer, dispenser } = freshDispenserCreateSuite());
}

// GET_TICK empty is the ordinary native-coin dispenser, so getTokenInfo is never
// loaded and the pre-existing format rule (a conjunct on it) short-circuits.
async function createWithGetAmount(getAmount, opts = {}) {
    const fiatCode   = opts.fiatCode   || '';
    const fiatAmount = opts.fiatAmount || '';
    const params = String(
        `0|BTC|JDOG|1||10|BTC||${getAmount}|${OWNER_ADDR}|${fiatCode}|${fiatAmount}||${EXPIRATION}|||`
    ).split('|');
    const data = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
    await dispenser.parse(params, data, false);
    return data['STATUS'];
}

function nativeCoinPriceCases() {
    beforeEach(freshCreateSuite);
    afterEach(function () { sinon.restore(); });

    it('accepts a valid native-coin price', async function () {
        assert.strictEqual(await createWithGetAmount('0.01'), 'valid');
    });

    it('rejects a NEGATIVE native-coin price', async function () {
        assert.strictEqual(await createWithGetAmount('-0.5'), 'invalid: GET_AMOUNT (format)');
    });

    it('rejects a NON-NUMERIC native-coin price', async function () {
        assert.strictEqual(await createWithGetAmount('abc'), 'invalid: GET_AMOUNT (format)');
    });

}

function nativeCoinPriceBoundaryCases() {
    beforeEach(freshCreateSuite);
    afterEach(function () { sinon.restore(); });

    it('rejects a price finer than COIN_DECIMALS', async function () {
        assert.strictEqual(await createWithGetAmount('0.000000001'), 'invalid: GET_AMOUNT (format)');
    });

    it('rejects a ZERO or empty price on a dispenser that names its own price', async function () {
        assert.strictEqual(await createWithGetAmount('0'), 'invalid: GET_AMOUNT (must be positive)');
        dispenser = makeDispenser(indexer);
        assert.strictEqual(await createWithGetAmount(''), 'invalid: GET_AMOUNT (must be positive)');
    });

    it('does not fire the positivity rule on a FIAT-priced dispenser', async function () {
        // GET_AMOUNT '0' is the documented FIAT shape (protocol/actions/dispenser.md),
        // where the price comes from FIAT_AMOUNT. A positivity rule without the FIAT
        // skip would reject both worked examples in that page. Asserted as "not this
        // error" rather than "valid": FIAT creates carry unrelated preconditions of
        // their own, and only the new rule is under test here.
        // A validator snapshot an hour old, so the FIAT create is priceable at BLOCK_TIME.
        indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000', timestamp: BLOCK_TIME - 3600 }]);
        for (const getAmount of ['0', '']) {
            const status = await createWithGetAmount(getAmount, { fiatCode: 'USD', fiatAmount: '0.05' });
            assert.notStrictEqual(status, 'invalid: GET_AMOUNT (must be positive)');
            assert.notStrictEqual(status, 'invalid: GET_AMOUNT (format)');
        }
    });
}

describe('Dispenser amount positivity @regression @tier2', function () {
    describe('DISPENSER create: native-coin GET_AMOUNT', nativeCoinPriceCases);
    describe('DISPENSER create: native-coin GET_AMOUNT', nativeCoinPriceBoundaryCases);
});

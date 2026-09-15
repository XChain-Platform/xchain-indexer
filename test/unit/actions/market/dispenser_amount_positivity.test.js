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
// Dispenser amount-positivity flag-day (dispenser_amount_positivity_activation.js).
//
// Every gated case carries its own FAILURE-REPRODUCING CONTROL: the same input with
// the gate forced off, asserted to still produce the ORIGINAL defective outcome. A
// suite that only asserted the post-fix verdict would pass identically if the harness
// never reached the defective path at all, and both readings must stay pinned anyway
// because the gate's whole purpose is byte-identical replay below the threshold.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const {
    activation, GATE_OFF_NETWORK, OWNER_ADDR, BLOCK_TIME, EXPIRATION,
    makeDispenser, freshDispenserCreateSuite,
} = require('./dispenser_amount_positivity.test/helpers/dispenser_amount_positivity_suite.js');

let indexer, dispenser;

function freshCreateSuite() {
    ({ indexer, dispenser } = freshDispenserCreateSuite());
}

// GET_TICK empty is the ordinary native-coin dispenser, so getTokenInfo is never
// loaded and the pre-existing format rule (a conjunct on it) short-circuits.
async function createWithGetAmount(getAmount, opts = {}) {
    if (opts.network)
        indexer.config['NETWORK'] = opts.network;
    const fiatCode   = opts.fiatCode   || '';
    const fiatAmount = opts.fiatAmount || '';
    const params = String(
        `0|BTC|JDOG|1||10|BTC||${getAmount}|${OWNER_ADDR}|${fiatCode}|${fiatAmount}||${EXPIRATION}|||`
    ).split('|');
    const data = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
    await dispenser.parse(params, data, false);
    return data['STATUS'];
}

function activationModuleCases() {
    it('mainnet is ARMED AT GENESIS by the 2026-09-09 ruling', function () {
        // 0 dispensers and 0 dispenses on mainnet (measured 2026-09-09), so both
        // enforcement points are identity over the indexed history.
        assert.strictEqual(activation.DISPENSER_AMOUNT_POSITIVITY_ACTIVATION.mainnet, 0);
        // Either sentinel reads back as "still unarmed" at the GoLiveGate.
        assert.notStrictEqual(activation.DISPENSER_AMOUNT_POSITIVITY_ACTIVATION.mainnet, 9999999999);
        assert.notStrictEqual(activation.DISPENSER_AMOUNT_POSITIVITY_ACTIVATION.mainnet, 999999999);
        assert.strictEqual(activation.isDispenserAmountPositivityActive(0, 'mainnet'), true);
        assert.strictEqual(activation.isDispenserAmountPositivityActive(BLOCK_TIME, 'mainnet'), true);
    });

    it('testnet and regtest run from genesis', function () {
        assert.strictEqual(activation.isDispenserAmountPositivityActive(0, 'testnet'), true);
        assert.strictEqual(activation.isDispenserAmountPositivityActive(0, 'regtest'), true);
    });

    it('an unknown network and a non-finite blockTime both read as off', function () {
        assert.strictEqual(activation.isDispenserAmountPositivityActive(BLOCK_TIME, GATE_OFF_NETWORK), false);
        assert.strictEqual(activation.isDispenserAmountPositivityActive('nonsense', 'regtest'), false);
    });

    it('the threshold binds at its own instant, not after it', function () {
        const map = activation.DISPENSER_AMOUNT_POSITIVITY_ACTIVATION;
        const saved = map.testnet;
        map.testnet = 1700000000;
        try {
            assert.strictEqual(activation.isDispenserAmountPositivityActive(1699999999, 'testnet'), false);
            assert.strictEqual(activation.isDispenserAmountPositivityActive(1700000000, 'testnet'), true);
        } finally {
            map.testnet = saved;
        }
    });
}

function nativeCoinPriceCases() {
    beforeEach(freshCreateSuite);
    afterEach(function () { sinon.restore(); });

    it('a valid native-coin price is still accepted with the gate on', async function () {
        assert.strictEqual(await createWithGetAmount('0.01'), 'valid');
    });

    it('rejects a NEGATIVE native-coin price, which nothing rejected before', async function () {
        assert.strictEqual(await createWithGetAmount('-0.5'), 'invalid: GET_AMOUNT (format)');
    });

    it('control: the same negative price is still ACCEPTED below the threshold', async function () {
        // The pre-fix outcome, and the byte-identical-replay guarantee. If this ever
        // reads 'invalid: ...' the gate has stopped gating; if the case above ever
        // reads 'valid' the rule has stopped binding. Neither can pass vacuously.
        assert.strictEqual(await createWithGetAmount('-0.5', { network: GATE_OFF_NETWORK }), 'valid');
    });

    it('rejects a NON-NUMERIC native-coin price', async function () {
        assert.strictEqual(await createWithGetAmount('abc'), 'invalid: GET_AMOUNT (format)');
    });

    it('control: the same non-numeric price is still ACCEPTED below the threshold', async function () {
        assert.strictEqual(await createWithGetAmount('abc', { network: GATE_OFF_NETWORK }), 'valid');
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
        for (const getAmount of ['0', '']) {
            const status = await createWithGetAmount(getAmount, { fiatCode: 'USD', fiatAmount: '0.05' });
            assert.notStrictEqual(status, 'invalid: GET_AMOUNT (must be positive)');
            assert.notStrictEqual(status, 'invalid: GET_AMOUNT (format)');
        }
    });
}

describe('Dispenser amount positivity @regression @tier2', function () {
    describe('activation module', activationModuleCases);
    describe('DISPENSER create: native-coin GET_AMOUNT', nativeCoinPriceCases);
    describe('DISPENSER create: native-coin GET_AMOUNT', nativeCoinPriceBoundaryCases);
});

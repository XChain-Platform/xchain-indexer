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
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Dispenser = require('../../../src/actions/dispenser.js');
const Dispense  = require('../../../src/actions/dispense.js');
const activation = require('../../../src/dispenser_amount_positivity_activation.js');

// Any network name the activation map does not carry reads as OFF, which is how these
// tests reach the legacy behavior without editing the module's thresholds.
const GATE_OFF_NETWORK = 'no-such-network';

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

describe('Dispenser amount positivity @regression @tier2', function () {

    const OWNER_ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const BUYER_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
    const BLOCK_TIME = 1700000000;
    const EXPIRATION = BLOCK_TIME + 86400 * 30;

    describe('activation module', function () {

        it('mainnet is UNARMED on the house sentinel', function () {
            assert.strictEqual(activation.DISPENSER_AMOUNT_POSITIVITY_ACTIVATION.mainnet, 9999999999);
            assert.strictEqual(activation.isDispenserAmountPositivityActive(BLOCK_TIME, 'mainnet'), false);
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
    });

    describe('DISPENSER create: native-coin GET_AMOUNT', function () {

        let indexer;
        let dispenser;

        beforeEach(function () {
            indexer   = createMockIndexer();
            dispenser = new Dispenser(makeActionsCtx(indexer));

            indexer.indexerDb.getTokenInfo
                .withArgs('JDOG', sinon.match.any, sinon.match.any)
                .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));
            for (const empty of ['', null, undefined])
                indexer.indexerDb.getTokenInfo.withArgs(empty, sinon.match.any, sinon.match.any).resolves(null);

            indexer.indexerDb.getAddressBalances.resolves({ 10: '1000' });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getTickerId.resolves(99);
        });

        afterEach(function () {
            sinon.restore();
        });

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

        it('rejects a price finer than COIN_DECIMALS', async function () {
            assert.strictEqual(await createWithGetAmount('0.000000001'), 'invalid: GET_AMOUNT (format)');
        });

        it('rejects a ZERO or empty price on a dispenser that names its own price', async function () {
            assert.strictEqual(await createWithGetAmount('0'), 'invalid: GET_AMOUNT (must be positive)');
            dispenser = new Dispenser(makeActionsCtx(indexer));
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
    });

    describe('DISPENSE settlement: fill count', function () {

        let indexer;
        let dispense;

        function makeDispenserInfo(overrides = {}) {
            return {
                ACTION_INDEX:   10,
                SOURCE:         OWNER_ADDR,
                GET_ADDRESS:    OWNER_ADDR,
                GIVE_COIN:      'BTC',
                GIVE_TICK:      'JDOG',
                GIVE_AMOUNT:    '1',
                GIVE_REMAINING: '10',
                GET_COIN:       'BTC',
                GET_TICK:       null,
                GET_AMOUNT:     '0.01',
                ALLOW_LIST:     null,
                BLOCK_LIST:     null,
                DISPENSER_STATUS: 'open',
                ...overrides,
            };
        }

        beforeEach(function () {
            indexer  = createMockIndexer();
            dispense = new Dispense(makeActionsCtx(indexer));

            indexer.indexerDb.findMatchingDispensers.resolves([10]);
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
            indexer.indexerDb.getTokenInfo
                .withArgs('JDOG', sinon.match.any, sinon.match.any)
                .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
            for (const empty of [null, undefined])
                indexer.indexerDb.getTokenInfo.withArgs(empty, sinon.match.any, sinon.match.any).resolves(null);
            indexer.indexerDb.createActionIndex.resolves(200);
        });

        afterEach(function () {
            sinon.restore();
        });

        async function settle(dispenserOverrides, opts = {}) {
            if (opts.network)
                indexer.config['NETWORK'] = opts.network;
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo(dispenserOverrides));
            const data = createBaseData({
                ACTION:      'DISPENSE',
                SOURCE:      BUYER_ADDR,
                COIN_AMOUNT: opts.coinAmount || '0.001',
                BLOCK_TIME,
            });
            await dispense.parse([], data, false);
            return indexer.indexerDb.createDispense.firstCall
                ? indexer.indexerDb.createDispense.firstCall.args[0]
                : null;
        }

        it('control: the arithmetic behind a negative fill count is real', function () {
            // Not a behavioral test: it pins that this fixture DOES drive the multiplier
            // negative, so the settlement cases below cannot pass by never reaching it.
            const util = indexer.util;
            const multiplier = util.bcfloorSaturating(util.bcdiv('0.001', '-0.5', 64));
            assert.strictEqual(multiplier, -1);
            assert.strictEqual(multiplier == 0, false, 'the legacy equality gate does not catch -1');
        });

        it('a negative fill count settles INVALID with the gate on', async function () {
            const rec = await settle({ GET_AMOUNT: '-0.5' });
            assert.ok(rec, 'a dispense row was recorded');
            assert.strictEqual(rec['STATUS'], 'invalid: insufficient funds ');
        });

        it('control: the same negative fill count still settles VALID below the threshold', async function () {
            // The original defect, reproduced: status valid carrying a NEGATIVE give_amount,
            // which the GIVE_REMAINING recompute subtracts and thereby manufactures escrow.
            const rec = await settle({ GET_AMOUNT: '-0.5' }, { network: GATE_OFF_NETWORK });
            assert.ok(rec, 'a dispense row was recorded');
            assert.strictEqual(rec['STATUS'], 'valid');
            assert.ok(indexer.util.bclt(rec['GIVE_AMOUNT'], '0'),
                `expected the legacy path to record a negative give_amount, got ${rec['GIVE_AMOUNT']}`);
        });

        it('a positive fill count is unaffected by the gate', async function () {
            const rec = await settle({}, { coinAmount: '0.02' });
            assert.strictEqual(rec['STATUS'], 'valid');
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '2');
        });

        it('a zero fill count keeps its legacy status text on both sides of the gate', async function () {
            // The status string is persisted, so the gated reading must not reword it.
            // An empty escrow drives the capacity clamp to a zero fill count, which is the
            // only route to this gate that a payment below GET_AMOUNT does not short-circuit.
            const on  = await settle({ GIVE_REMAINING: '0' }, { coinAmount: '0.01' });
            assert.strictEqual(on['STATUS'], 'invalid: insufficient funds ');
            indexer.indexerDb.createDispense.resetHistory();
            const off = await settle({ GIVE_REMAINING: '0' }, { coinAmount: '0.01', network: GATE_OFF_NETWORK });
            assert.strictEqual(off['STATUS'], 'invalid: insufficient funds ');
        });

        it('control: a non-numeric GET_AMOUNT THROWS out of the raw divide', function () {
            // The pre-fix behavior at this call site, executed rather than asserted: the
            // throw escapes parse() into the block loop, which retries the block forever.
            assert.throws(() => indexer.util.bcdiv('0.001', 'abc', 64));
        });

        it('a non-numeric GET_AMOUNT settles INVALID instead of wedging, ungated', async function () {
            for (const network of ['regtest', GATE_OFF_NETWORK]) {
                indexer.indexerDb.createDispense.resetHistory();
                const rec = await settle({ GET_AMOUNT: 'abc' }, { network });
                assert.ok(rec, `a dispense row was recorded on ${network}`);
                assert.strictEqual(rec['STATUS'], 'invalid: GET_AMOUNT (format)',
                    `expected the ungated format reject on ${network}`);
            }
        });

        it("'Infinity' and 'NaN' keep their legacy insufficient-funds verdict", async function () {
            // Both divide to 0 rather than throwing, so the ungated catch must NOT claim
            // them: an isNumeric() pre-screen would, and would change a committed status.
            for (const value of ['Infinity', 'NaN']) {
                indexer.indexerDb.createDispense.resetHistory();
                const rec = await settle({ GET_AMOUNT: value }, { network: GATE_OFF_NETWORK });
                assert.ok(rec, `a dispense row was recorded for ${value}`);
                assert.strictEqual(rec['STATUS'], 'invalid: insufficient funds ',
                    `${value} must keep the legacy verdict`);
            }
        });
    });
});

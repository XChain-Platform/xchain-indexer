'use strict';

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
// Amount representability flag-day (amount_representability_activation.js).
//
// isValidAmountFormat validated amount TEXT: it split on '.', asked isNumeric() of each
// half, and capped the fractional half's DIGIT COUNT. isNumeric() accepts the whole
// JavaScript number grammar, so '5e-19' passed at 18 decimals and bcadd then credited
// 1e-18 - a DIFFERENT number from the one that was checked - while '1e-1' passed on an
// INDIVISIBLE tick and credited 0, and a 43-digit integer passed but does not fit the
// DECIMAL(60,18) the ledger aggregations cast to.
//
// Every gated case here carries its FAILURE-REPRODUCING CONTROL: the same input with the
// gate forced off, asserted to still produce the ORIGINAL wrong outcome. Without that
// control a green run would look identical if the harness never reached the validator at
// all, and the below-threshold reading has to stay pinned anyway because byte-identical
// replay is the whole point of the gate.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Utility    = require('../../../src/utility.js');
const Send       = require('../../../src/actions/send.js');
const activation = require('../../../src/amount_representability_activation.js');

// Any network the activation map does not carry reads as OFF, which is how these tests
// reach the legacy behavior without editing the module's thresholds.
const GATE_OFF_NETWORK = 'no-such-network';

// A block time inside the regtest-armed window and far below the unarmed sentinel.
const BLOCK_TIME = 1700000000;

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST   = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

// Run `fn` with the regtest threshold temporarily moved, restoring it byte-exact after.
// Used for the gate-off controls that must isolate THIS gate rather than turning every
// network-keyed gate in the action path off at once.
function withRegtestThreshold(value, fn) {
    const map   = activation.AMOUNT_REPRESENTABILITY_ACTIVATION;
    const saved = map.regtest;
    map.regtest = value;
    try { return fn(); } finally { map.regtest = saved; }
}

// The async form. The synchronous one restores the threshold the instant `fn` RETURNS,
// which for an async `fn` is before it has reached the validator at all, so the control
// would silently run with the gate back on. Measured: the SEND control below failed
// exactly that way on its first run.
async function withRegtestThresholdAsync(value, fn) {
    const map   = activation.AMOUNT_REPRESENTABILITY_ACTIVATION;
    const saved = map.regtest;
    map.regtest = value;
    try { return await fn(); } finally { map.regtest = saved; }
}

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

describe('Amount representability @regression @tier1', function () {

    describe('activation module', function () {

        it('mainnet is UNARMED on the house sentinel', function () {
            assert.strictEqual(activation.AMOUNT_REPRESENTABILITY_ACTIVATION.mainnet, 9999999999);
            // Unarmed means unarmed at any time a real chain will reach this decade.
            assert.strictEqual(activation.isAmountRepresentabilityActive(BLOCK_TIME, 'mainnet'), false);
            assert.strictEqual(activation.isAmountRepresentabilityActive(0, 'mainnet'), false);
        });

        it('testnet is UNARMED: it has live launched history no measurement here can re-judge', function () {
            assert.strictEqual(activation.AMOUNT_REPRESENTABILITY_ACTIVATION.testnet, 9999999999);
            assert.strictEqual(activation.isAmountRepresentabilityActive(BLOCK_TIME, 'testnet'), false);
        });

        it('regtest runs from genesis', function () {
            assert.strictEqual(activation.AMOUNT_REPRESENTABILITY_ACTIVATION.regtest, 0);
            assert.strictEqual(activation.isAmountRepresentabilityActive(0, 'regtest'), true);
            assert.strictEqual(activation.isAmountRepresentabilityActive(BLOCK_TIME, 'regtest'), true);
        });

        it('an unknown network and a non-finite blockTime both read as off', function () {
            assert.strictEqual(activation.isAmountRepresentabilityActive(BLOCK_TIME, GATE_OFF_NETWORK), false);
            assert.strictEqual(activation.isAmountRepresentabilityActive('nonsense', 'regtest'), false);
            assert.strictEqual(activation.isAmountRepresentabilityActive(undefined, 'regtest'), false);
        });

        it('the threshold binds at its own instant, not after it', function () {
            withRegtestThreshold(BLOCK_TIME, function () {
                assert.strictEqual(activation.isAmountRepresentabilityActive(BLOCK_TIME - 1, 'regtest'), false);
                assert.strictEqual(activation.isAmountRepresentabilityActive(BLOCK_TIME, 'regtest'), true);
            });
        });
    });

    describe('isRepresentableAmount() rule', function () {

        const REJECTED = [
            [18, '5e-19',                 'exponent notation, small'],
            [8,  '1e2',                   'exponent notation, large'],
            [8,  '1e+5',                  'exponent notation, explicit sign'],
            [0,  '1e-1',                  'exponent notation on an indivisible tick'],
            [8,  '0x10',                  'hex radix prefix'],
            [8,  '0b101',                 'binary radix prefix'],
            [8,  '0o17',                  'octal radix prefix'],
            [8,  '+1.5',                  'leading plus'],
            [8,  '-1.5',                  'leading minus'],
            [8,  '1.5 ',                  'trailing whitespace'],
            [8,  ' 1.5',                  'leading whitespace'],
            [8,  '1.',                    'empty fractional half'],
            [8,  '.5',                    'empty integer half'],
            [8,  '',                      'empty string'],
            [8,  '1.2.3',                 'two decimal points'],
            [8,  'abc',                   'not a numeral at all'],
            [8,  'Infinity',              'infinity'],
            [8,  'NaN',                   'nan'],
            [8,  null,                    'null (what safeToString returns for an unstringifiable value)'],
            [8,  undefined,               'undefined'],
            [8,  1.5,                     'a raw JS number: the rule takes RENDERED text, never a raw value'],
            [8,  { toString: () => '1' }, 'a raw object: rendering is safeToString\'s job, not this rule\'s'],
            [18, '1'.repeat(43),          '43 integer digits, one past DECIMAL(60,18) capacity'],
            [8,  '1.000000001',           'more fractional digits than the tick carries'],
            [0,  '1.5',                   'a fraction on an indivisible tick'],
        ];
        REJECTED.forEach(function ([decimals, amount, why]) {
            it(`rejects ${JSON.stringify(amount)} at ${decimals} decimals (${why})`, function () {
                assert.strictEqual(activation.isRepresentableAmount(decimals, amount), false);
            });
        });

        const ACCEPTED = [
            [0,  '100',                'a plain integer on an indivisible tick'],
            [8,  '100',                'a plain integer on a divisible tick'],
            [8,  '1.5',                'fewer fractional digits than the tick carries'],
            [8,  '1.00000001',         'exactly the tick precision'],
            [8,  '1.50000000',         'trailing fractional zeros'],
            [8,  '007',                'leading zeros: exactly representable, not this rule\'s business'],
            [8,  '0.5',                'a leading zero before the point'],
            [8,  '0',                  'zero'],
            [18, '1'.repeat(42),       '42 integer digits, exactly DECIMAL(60,18) capacity'],
            [18, '0'.repeat(10) + '1'.repeat(42), 'leading zeros do not count against the digit cap'],
        ];
        ACCEPTED.forEach(function ([decimals, amount, why]) {
            it(`accepts ${JSON.stringify(amount)} at ${decimals} decimals (${why})`, function () {
                assert.strictEqual(activation.isRepresentableAmount(decimals, amount), true);
            });
        });

        it('the 42-digit boundary is the DECIMAL(60,18) integer capacity, not an arbitrary number', function () {
            assert.strictEqual(activation.AMOUNT_MAX_INTEGER_DIGITS, 60 - 18);
        });
    });

    describe('isValidAmountFormat(): the credited number vs the validated text', function () {

        let util;
        beforeEach(function () { util = new Utility(); });

        it('the defect: 5e-19 validates but bcadd credits a DIFFERENT number', function () {
            // This is the whole item in one assertion. Legacy (two-argument) acceptance is
            // still pinned here because that is what replay below the threshold must keep
            // doing, and the credited value is measured, not assumed.
            assert.strictEqual(util.isValidAmountFormat(18, '5e-19'), true);
            assert.notStrictEqual(String(util.bcadd('5e-19', 0, 18)), '5e-19');
            assert.strictEqual(String(util.bcadd('5e-19', 0, 18)), '1e-18');
            // Armed, it is refused before it can be credited.
            assert.strictEqual(util.isValidAmountFormat(18, '5e-19', BLOCK_TIME), false);
        });

        it('the defect: 1e-1 validates on an INDIVISIBLE tick and credits 0', function () {
            assert.strictEqual(util.isValidAmountFormat(0, '1e-1'), true);
            assert.strictEqual(String(util.bcadd('1e-1', 0, 0)), '0');
            assert.strictEqual(util.isValidAmountFormat(0, '1e-1', BLOCK_TIME), false);
        });

        it('the defect: 43 integer digits validate but do not fit DECIMAL(60,18)', function () {
            const big = '1'.repeat(43);
            assert.strictEqual(util.isValidAmountFormat(18, big), true);
            assert.strictEqual(util.isValidAmountFormat(18, big, BLOCK_TIME), false);
            // 42 digits is representable and stays accepted armed, so the cap is a boundary
            // rather than a blanket refusal of large amounts.
            assert.strictEqual(util.isValidAmountFormat(18, '1'.repeat(42), BLOCK_TIME), true);
        });

        it('armed, the whole non-numeral family is refused', function () {
            for (const amount of ['0x10', '0b101', '1e+5', '+1.5', '1.5 ', '1.'])
                assert.strictEqual(util.isValidAmountFormat(8, amount, BLOCK_TIME), false, amount);
        });

        it('control: the same family is still ACCEPTED below the threshold (byte-identical replay)', function () {
            // If this ever reads false the gate has stopped gating and replay of committed
            // history would diverge. It cannot pass vacuously: the case above asserts the
            // armed reading of the same inputs.
            withRegtestThreshold(9999999999, function () {
                for (const amount of ['0x10', '0b101', '1e+5', '+1.5', '1.5 ', '1.'])
                    assert.strictEqual(util.isValidAmountFormat(8, amount, BLOCK_TIME), true, amount);
                assert.strictEqual(util.isValidAmountFormat(18, '5e-19', BLOCK_TIME), true);
            });
        });

        it('a two-argument call is legacy on every network, armed or not', function () {
            // The SDK and the genesis config check call it this way on purpose. Regtest is
            // armed at genesis, so if the gate leaked into the two-argument form this would
            // read false.
            assert.strictEqual(util.config['NETWORK'], 'regtest');
            assert.strictEqual(activation.isAmountRepresentabilityActive(BLOCK_TIME, 'regtest'), true);
            assert.strictEqual(util.isValidAmountFormat(8, '0x10'), true);
            assert.strictEqual(util.isValidAmountFormat(18, '5e-19'), true);
        });

        it('the gate only ever REJECTS more: every legacy-valid case stays valid armed', function () {
            const stillValid = [
                [0, '100'], [8, '100'], [8, '1.5'], [8, '1.00000001'],
                [8, '1.50000000'], [2, '1.12'], [8, '0'], [8, '0.5'], [8, '007'],
            ];
            for (const [d, a] of stillValid) {
                assert.strictEqual(util.isValidAmountFormat(d, a), true, `legacy ${d} ${a}`);
                assert.strictEqual(util.isValidAmountFormat(d, a, BLOCK_TIME), true, `armed ${d} ${a}`);
            }
        });

        it('every legacy-invalid case is still invalid armed', function () {
            const stillInvalid = [
                [0, '1.5'], [8, 'abc'], [8, '1.000000001'], [2, '1.123'],
                [8, '1.2.3'], [0, '1.2.3'], [0, '-100'], [8, '-1.5'],
            ];
            for (const [d, a] of stillInvalid) {
                assert.strictEqual(util.isValidAmountFormat(d, a), false, `legacy ${d} ${a}`);
                assert.strictEqual(util.isValidAmountFormat(d, a, BLOCK_TIME), false, `armed ${d} ${a}`);
            }
        });

        it('a merged bignumber amount is still accepted armed (the regression this caused)', function () {
            // The SEND/DESTROY leg merge hands bcadd's RETURN VALUE - a mathjs bignumber
            // object, not a string - straight to this validator. A first cut of the rule
            // refused every non-string and turned five consolidation cases red. Rendering
            // through safeToString (fixed notation) is what keeps a legitimate merged
            // amount valid, and a plain String() would not: it can produce exponent
            // notation for the very value the rule exists to certify.
            const merged = util.bcadd('50', '30', 0);
            assert.strictEqual(typeof merged, 'object');
            assert.strictEqual(util.isValidAmountFormat(0, merged, BLOCK_TIME), true);
            const big = util.bcadd('1' + '0'.repeat(20), '0', 8);
            assert.strictEqual(util.isValidAmountFormat(8, big, BLOCK_TIME), true);
        });

        it('object handling is unchanged from legacy: the gate only judges the rendered text', function () {
            // safeToString already decides which objects may be stringified, and the legacy
            // body already accepts one whose render is a numeral. This gate does not
            // re-open that question, so armed and legacy agree on both shapes.
            const numeralish = { toString: () => '1.5' };
            assert.strictEqual(util.isValidAmountFormat(8, numeralish), true);
            assert.strictEqual(util.isValidAmountFormat(8, numeralish, BLOCK_TIME), true);
            const exponentish = { toString: () => '1e2' };
            assert.strictEqual(util.isValidAmountFormat(8, exponentish), true);
            assert.strictEqual(util.isValidAmountFormat(8, exponentish, BLOCK_TIME), false);
        });

        it('isValidFiatFormat forwards the block context', function () {
            assert.strictEqual(util.isValidFiatFormat(2, '1e1'), true);
            assert.strictEqual(util.isValidFiatFormat(2, '1e1', BLOCK_TIME), false);
            assert.strictEqual(util.isValidFiatFormat(2, '10.99', BLOCK_TIME), true);
        });
    });

    describe('SEND: the gate reaches a real action path', function () {

        let indexer, handler, rows;

        beforeEach(function () {
            indexer = createMockIndexer();
            handler = new Send(makeActionsCtx(indexer));
            rows    = [];

            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 8 }));
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressBalances.resolves({ 1: 1000 });
            indexer.indexerDb.findMatchingDispensers.resolves([]);
            indexer.indexerDb.findDispenserSends.resolves([]);
            indexer.indexerDb.createSend.callsFake(async (s) => {
                rows.push({ AMOUNT: String(s['AMOUNT']), STATUS: s['STATUS'] });
            });
        });

        afterEach(function () { sinon.restore(); });

        async function parse(params) {
            const data = createBaseData({ ACTION: 'SEND', FORMAT: params[0] | 0, SOURCE, BLOCK_TIME });
            await handler.parse(params, data, null);
            return data['STATUS'];
        }

        it('an exponent-notation AMOUNT is rejected', async function () {
            assert.strictEqual(await parse(['0', 'TEST', '1e2', DEST, '']), 'invalid: AMOUNT (format)');
        });

        it('control: below the threshold that same SEND settles, and settles the WRONG number', async function () {
            // The pre-fix outcome. '1e2' was validated as a 1 with a 2-character "fraction"
            // and then credited as 100, so the control also measures the laundering rather
            // than merely observing a green status.
            const status = await withRegtestThresholdAsync(9999999999,
                () => parse(['0', 'TEST', '1e2', DEST, '']));
            assert.strictEqual(status, 'valid');
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(indexer.util.bcformat(rows[0].AMOUNT, 8), '100.00000000');
        });

        it('an honest AMOUNT still settles with the gate on', async function () {
            assert.strictEqual(await parse(['0', 'TEST', '1.5', DEST, '']), 'valid');
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(indexer.util.bcformat(rows[0].AMOUNT, 8), '1.50000000');
        });

        it('an exponent leg is held OUT of the multi-leg merge instead of summing into a passing total', async function () {
            // The merge key is computed from the same validator, so an unrepresentable leg
            // must reach the per-leg check on its own rather than being bcadd-ed into a
            // total that passes.
            const status = await parse(['1', 'TEST', '1e2', DEST, '1e2', DEST, '']);
            assert.strictEqual(status, 'invalid: AMOUNT (format)');
            assert.strictEqual(rows.length, 2);
            assert.deepStrictEqual(rows.map(r => r.STATUS),
                ['invalid: AMOUNT (format)', 'invalid: AMOUNT (format)']);
        });
    });
});

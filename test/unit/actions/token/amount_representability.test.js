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
const {
    activation, GATE_OFF_NETWORK, BLOCK_TIME, withRegtestThreshold,
} = require('./amount_representability.test/helpers/amount_representability_suite.js');

function activationModuleCases() {
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
}

function rejectedRepresentableAmountCases() {
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
}

describe('Amount representability @regression @tier1', function () {
    describe('activation module', activationModuleCases);
    describe('isRepresentableAmount() rule', rejectedRepresentableAmountCases);
});

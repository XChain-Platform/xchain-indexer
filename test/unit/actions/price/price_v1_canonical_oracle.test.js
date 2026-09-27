/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Pins the regex-free reference oracle against the fixed cases the
 * production VALUE/FEE checks must agree on, then exhaustively compares
 * it to today's shipped PRICE_VALUE_RE_CANONICAL over every short string
 * drawn from the digits and separator that pattern actually cares about.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const ProtocolChanges = require('../../../../src/protocol_changes.js');
const {
    isCanonicalV1ValueText,
    isCanonicalV1FeeText,
} = require('./helpers/price_v1_canonical_oracle.js');

const BOTH_TRUE = [
    '12345.12345678',
    '0',
    '0.01',
    '1',
];

const BOTH_FALSE = [
    '0012.5',
    '01',
    '00.5',
    '.5',
    '1.',
    '1.2.3',
    '-1',
    '1 ',
    '',
];

describe('PRICE v1 canonical reference oracle @regression @tier3', function () {

    it('agrees with the honest and malformed pins for both VALUE and FEE', function () {
        for (const text of BOTH_TRUE) {
            assert.strictEqual(isCanonicalV1ValueText(text, Infinity), true, text);
            assert.strictEqual(isCanonicalV1FeeText(text, Infinity), true, text);
        }
        for (const text of BOTH_FALSE) {
            assert.strictEqual(isCanonicalV1ValueText(text, Infinity), false, JSON.stringify(text));
            assert.strictEqual(isCanonicalV1FeeText(text, Infinity), false, JSON.stringify(text));
        }
    });

    it('splits VALUE and FEE at the 8-versus-18 fraction-digit bound', function () {
        assert.strictEqual(isCanonicalV1ValueText('1.123456789', Infinity), false);
        assert.strictEqual(isCanonicalV1FeeText('1.123456789', Infinity), true);
    });

    it('bounds FEE fraction digits at 18', function () {
        assert.strictEqual(isCanonicalV1FeeText('0.' + '1'.repeat(18), Infinity), true);
        assert.strictEqual(isCanonicalV1FeeText('0.' + '1'.repeat(19), Infinity), false);
    });

    // The row's own 20-character example ('12345678901.1234567') measures 19
    // chars and is admitted at cap 19, so it cannot show the cap boundary it
    // was named for; this string is the same shape at the length the row
    // describes (11 integer digits, 8 fraction digits, 20 chars total).
    it('caps VALUE length at maxLength', function () {
        const nineteen = '1234567890.12345678';
        const twenty   = '12345678901.12345678';
        assert.strictEqual(nineteen.length, 19);
        assert.strictEqual(twenty.length, 20);

        assert.strictEqual(isCanonicalV1ValueText(nineteen, 19), true);
        assert.strictEqual(isCanonicalV1ValueText(twenty, 19), false);
        assert.strictEqual(isCanonicalV1ValueText(twenty, 20), true);
    });

    it('refuses a non-string text', function () {
        assert.strictEqual(isCanonicalV1ValueText(undefined, Infinity), false);
        assert.strictEqual(isCanonicalV1ValueText(null, Infinity), false);
        assert.strictEqual(isCanonicalV1ValueText(12, Infinity), false);
        assert.strictEqual(isCanonicalV1FeeText(undefined, Infinity), false);
        assert.strictEqual(isCanonicalV1FeeText(null, Infinity), false);
        assert.strictEqual(isCanonicalV1FeeText(12, Infinity), false);
    });

    it('matches the shipped PRICE_VALUE_RE_CANONICAL over every short candidate', function () {
        const canonicalRe = ProtocolChanges.get('price_scale_activation.PRICE_VALUE_RE_CANONICAL');
        const alphabet = ['0', '1', '9', '.'];
        let checked = 0;

        for (const text of everyStringUpTo(alphabet, 5)) {
            assert.strictEqual(
                isCanonicalV1ValueText(text, Infinity), canonicalRe.test(text), JSON.stringify(text));
            checked++;
        }
        assert.strictEqual(checked, 4 + 16 + 64 + 256 + 1024);
    });
});

// Every string of length 1..maxLen over `alphabet`, shortest first.
function everyStringUpTo(alphabet, maxLen) {
    const out = [];
    let level = [''];
    for (let len = 1; len <= maxLen; len++) {
        const next = [];
        for (const prefix of level) {
            for (const ch of alphabet) next.push(prefix + ch);
        }
        out.push(...next);
        level = next;
    }
    return out;
}

'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ProtocolChanges = require('../../../../src/protocol_changes.js');
const { buildPriceV1RefusalCases } = require('./helpers/price_v1_refusal_cases.js');

const V1_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'src', 'actions', 'price', 'v1.js'), 'utf8');

// Today's inline v1.js field rules (VALUE 1-8 decimals, FEE 1-18); the source
// check below fails loudly if v1.js's literals ever drift from these.
const LEGACY_VALUE_RE = /^[0-9]+(\.[0-9]{1,8})?$/;
const LEGACY_FEE_RE   = /^[0-9]+(\.[0-9]{1,18})?$/;

const CANONICAL_VALUE_RE = ProtocolChanges.get('price_scale_activation.PRICE_VALUE_RE_CANONICAL');
// Design section 1 FEE pattern: the canonical VALUE pattern with its 8-digit
// fraction widened to 18, following the Design section 1 FEE derivation.
const CANONICAL_FEE_RE = new RegExp(CANONICAL_VALUE_RE.source.replace('{1,8}', '{1,18}'));

describe('PRICE v1 refusal case fixtures', function () {
    it('mirrors the legacy VALUE and FEE patterns v1.js carries today', function () {
        assert.ok(V1_SOURCE.includes(LEGACY_VALUE_RE.source));
        assert.ok(V1_SOURCE.includes(LEGACY_FEE_RE.source));
    });

    it('builds the four cases in order for caps { value: 19, fee: 20 }', function () {
        const cases = buildPriceV1RefusalCases({ value: 19, fee: 20 });
        assert.deepStrictEqual(cases, [
            { name: 'leading-zero VALUE', value: '0012.5', fee: '', status: 'invalid: VALUE (format)' },
            { name: 'leading-zero FEE', value: '12.5', fee: '00.5', status: 'invalid: FEE (format)' },
            {
                name: 'VALUE one over its cap', value: '10000000000.12345678', fee: '',
                status: 'invalid: VALUE (format)',
            },
            {
                name: 'FEE one over its cap', value: '12.5', fee: '10.000000000000000001',
                status: 'invalid: FEE (format)',
            },
        ]);
    });

    it('scales the over-cap texts to exactly cap + 1 characters at caps { value: 25, fee: 30 }', function () {
        const cases = buildPriceV1RefusalCases({ value: 25, fee: 30 });
        assert.strictEqual(cases[2].value.length, 26);
        assert.strictEqual(cases[3].fee.length, 31);
    });

    it('matches the over-cap texts against the canonical patterns at both cap pairs', function () {
        for (const caps of [{ value: 19, fee: 20 }, { value: 25, fee: 30 }]) {
            const cases = buildPriceV1RefusalCases(caps);
            assert.strictEqual(CANONICAL_VALUE_RE.test(cases[2].value), true, cases[2].value);
            assert.strictEqual(CANONICAL_FEE_RE.test(cases[3].fee), true, cases[3].fee);
        }
    });

    it('fails the leading-zero texts against canonical yet passes them against legacy', function () {
        const cases = buildPriceV1RefusalCases({ value: 19, fee: 20 });
        assert.strictEqual(CANONICAL_VALUE_RE.test(cases[0].value), false, cases[0].value);
        assert.strictEqual(LEGACY_VALUE_RE.test(cases[0].value), true, cases[0].value);
        assert.strictEqual(CANONICAL_FEE_RE.test(cases[1].fee), false, cases[1].fee);
        assert.strictEqual(LEGACY_FEE_RE.test(cases[1].fee), true, cases[1].fee);
    });

    it('throws when a cap sits below the grammar floors of 19 and 20', function () {
        for (const caps of [{ value: 18, fee: 20 }, { value: 19, fee: 19 }, { value: 19.5, fee: 20 }])
            assert.throws(() => buildPriceV1RefusalCases(caps));
    });
});

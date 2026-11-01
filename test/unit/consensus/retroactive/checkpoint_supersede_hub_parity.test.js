/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Keep the indexer and hub checkpoint supersession suffixes in parity.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { supersedeSuffix } = require('../../../../src/consensus/retroactive/checkpoint_supersede.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const HUB_COPY = '../../../../../xchain-hub/src/anchor/checkpoint_engine/supersede_suffix.js';
const DIGEST = 'ab'.repeat(32);
const VECTORS = [
    ['both fields absent', {}],
    ['both fields null', { supersedes_from: null, rules_digest: null }],
    ['numeric supersedes_from', { supersedes_from: 40, rules_digest: DIGEST }],
    ['string supersedes_from and uppercase digest', { supersedes_from: '40', rules_digest: DIGEST.toUpperCase() }],
    ['zero supersedes_from', { supersedes_from: 0, rules_digest: DIGEST }],
    ['only supersedes_from', { supersedes_from: 40 }],
    ['only rules_digest', { rules_digest: DIGEST }],
    ['negative supersedes_from', { supersedes_from: -1, rules_digest: DIGEST }],
    ['fractional supersedes_from', { supersedes_from: 1.5, rules_digest: DIGEST }],
    ['non-numeric supersedes_from', { supersedes_from: 'x', rules_digest: DIGEST }],
    ['unsafe supersedes_from', { supersedes_from: 2 ** 53, rules_digest: DIGEST }],
    ['short rules_digest', { supersedes_from: 4, rules_digest: 'ab' }],
    ['long rules_digest', { supersedes_from: 4, rules_digest: DIGEST + '0' }],
    ['non-hex rules_digest', { supersedes_from: 4, rules_digest: 'g'.repeat(64) }],
    ['non-string rules_digest', { supersedes_from: 4, rules_digest: 7 }],
];

function invokeWithoutMutation(fn, vector) {
    const input = Object.assign({}, vector);
    const before = Object.assign({}, input);
    let outcome;
    try {
        outcome = { threw: false, value: fn(input) };
    } catch (error) {
        outcome = { threw: true };
    }
    assert.deepStrictEqual(input, before);
    if (!outcome.threw) assert.strictEqual(typeof outcome.value, 'string');
    return outcome;
}

describe('checkpoint supersede suffix hub parity @regression @tier1', function () {
    let hubSupersedeSuffix;

    before(function () {
        const hubCheckout = siblingCheckout(__dirname, HUB_COPY);
        if (!hubCheckout.usable)
            return skipOrFail(this, hubCheckout, 'the xchain-hub supersedeSuffix parity guard');
        hubSupersedeSuffix = require(hubCheckout.path).supersedeSuffix;
    });

    it('returns the same string or throws on both sides without mutating either input', function () {
        for (const [label, vector] of VECTORS) {
            const indexer = invokeWithoutMutation(supersedeSuffix, vector);
            const hub = invokeWithoutMutation(hubSupersedeSuffix, vector);
            assert.deepStrictEqual(indexer, hub, label);
        }
    });

    it('emits the exact suffix bytes for an uppercase rules_digest', function () {
        const vector = { supersedes_from: '40', rules_digest: DIGEST.toUpperCase() };
        const expected = '|SUPERSEDE|40|' + DIGEST;
        assert.deepStrictEqual(invokeWithoutMutation(supersedeSuffix, vector), { threw: false, value: expected });
        assert.deepStrictEqual(invokeWithoutMutation(hubSupersedeSuffix, vector), { threw: false, value: expected });
    });
});

'use strict';

// Copyright 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { parsePinnedSet } = require('../../../../src/consensus/capability_snapshot_proof/pinned.js');

const LOWER_KEY = 'a'.repeat(64);
const UPPER_KEY = 'B'.repeat(64);

function entry(pubkey = LOWER_KEY, weight = '1', source = 'source-1') {
    return { pubkey, weight, source };
}

function refusal(value) {
    const result = parsePinnedSet(value);
    assert.strictEqual(result.set, null);
    assert.strictEqual(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    return result.error;
}

describe('capability snapshot proof pinned set parser', function () {
    it('accepts a one-entry set', function () {
        const expected = [entry()];
        assert.deepStrictEqual(parsePinnedSet(JSON.stringify(expected)), { set: expected, error: null });
    });

    it('accepts two sources and an uppercase public key', function () {
        const expected = [entry(LOWER_KEY, '2', 'source-1'), entry(UPPER_KEY, '3', 'source-2')];
        assert.deepStrictEqual(parsePinnedSet(JSON.stringify(expected)), { set: expected, error: null });
    });

    it('refuses invalid JSON', function () {
        assert.match(refusal('not json'), /^is not valid JSON \(/);
    });

    it('refuses a non-array value', function () {
        assert.strictEqual(refusal(JSON.stringify({})), 'is not a JSON array');
    });

    it('refuses an empty array', function () {
        assert.strictEqual(refusal(JSON.stringify([])), 'is an empty array (an empty set verifies nothing)');
    });

    it('refuses a 63-hex public key and names its entry', function () {
        assert.strictEqual(refusal(JSON.stringify([entry(LOWER_KEY.slice(1))])),
            'entry 0 `pubkey` is not a 64-hex Ed25519 public key');
    });

    it('refuses a numeric weight and names its entry', function () {
        assert.strictEqual(refusal(JSON.stringify([entry(LOWER_KEY, 1)])),
            'entry 0 has no string `weight`');
    });

    it('refuses a blank source and names its entry', function () {
        assert.match(refusal(JSON.stringify([entry(LOWER_KEY, '1', '')])),
            /^entry 0 has an unusable stake field \(/);
    });

    it('refuses a negative weight and names its entry', function () {
        assert.match(refusal(JSON.stringify([entry(LOWER_KEY, '-1')])),
            /^entry 0 has an unusable stake field \(/);
    });

    it('refuses a nonnumeric weight and names its entry', function () {
        assert.match(refusal(JSON.stringify([entry(LOWER_KEY, 'x')])),
            /^entry 0 has an unusable stake field \(/);
    });

    it('refuses a zero-only set', function () {
        assert.strictEqual(refusal(JSON.stringify([entry(LOWER_KEY, '0')])),
            'has zero total stake (the stake-weighted quorum can never be met)');
    });

    it('refuses a null entry and names its index', function () {
        assert.strictEqual(refusal(JSON.stringify([entry(), null])), 'entry 1 is not an object');
    });

    it('refuses a non-object entry and names its index', function () {
        assert.strictEqual(refusal(JSON.stringify([entry(), 'invalid'])), 'entry 1 is not an object');
    });
});

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

// The v2 canonical value serialisation (VCS). Every expected string below is
// written out by hand from the type table in the fingerprint v2 design, not
// computed by the module under test, so a change to the serialisation shows
// up here as a literal mismatch rather than agreeing with itself.

const assert = require('assert');
const crypto = require('crypto');
const canon  = require('../../../../src/consensus/armed_map/canonical.js');

const { canonicalValue, preimage, fingerprint, ArmedMapCanonicalError, DOMAIN, KEY_RE } = canon;

function sha(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

class Height { constructor() { this.v = 1; } }

describe('armed_map/canonical: value serialisation', function () {

    it('writes scalars as the design table says', function () {
        assert.strictEqual(canonicalValue(null), 'null');
        assert.strictEqual(canonicalValue(true), 'true');
        assert.strictEqual(canonicalValue(false), 'false');
        assert.strictEqual(canonicalValue(145000), '145000');
        assert.strictEqual(canonicalValue(9999999999), '9999999999');
        assert.strictEqual(canonicalValue(0.5), '0.5');
        assert.strictEqual(canonicalValue(1e21), '1e+21');
        assert.strictEqual(canonicalValue('BTC:testnet'), '"BTC:testnet"');
        assert.strictEqual(canonicalValue('quote " and \\ slash'), '"quote \\" and \\\\ slash"');
    });

    it('writes -0 as 0, so a negative zero is the same height as zero', function () {
        assert.strictEqual(canonicalValue(-0), '0');
        assert.strictEqual(canonicalValue({ h: -0 }), canonicalValue({ h: 0 }));
    });

    it('writes a RegExp as its source and flags, so two patterns never collide', function () {
        assert.strictEqual(canonicalValue(/^[A-Z]{3,5}$/), 're:"^[A-Z]{3,5}$":""');
        assert.strictEqual(canonicalValue(/a\/b/gi), 're:"a\\\\/b":"gi"');
        assert.notStrictEqual(canonicalValue(/a/), canonicalValue(/b/));
        assert.notStrictEqual(canonicalValue(/a/), canonicalValue(/a/i));
    });

    it('keeps array order and sorts object keys by code unit', function () {
        assert.strictEqual(canonicalValue([3, 1, 2]), '[3,1,2]');
        assert.strictEqual(canonicalValue({ testnet: 1, mainnet: null, 'BTC:regtest': 0 }),
            '{"BTC:regtest":0,"mainnet":null,"testnet":1}');
        assert.strictEqual(canonicalValue({ b: 1, a: 2 }), canonicalValue({ a: 2, b: 1 }));
        // Upper case sorts before lower case in code-unit order; a locale sort would not.
        assert.strictEqual(canonicalValue({ a: 1, Z: 2 }), '{"Z":2,"a":1}');
        assert.strictEqual(canonicalValue({ o: [{ y: 1, x: [] }] }), '{"o":[{"x":[],"y":1}]}');
    });

    it('omits an undefined object key, and keeps null distinct from it', function () {
        assert.strictEqual(canonicalValue({ a: 1, b: undefined }), '{"a":1}');
        assert.strictEqual(canonicalValue({ a: 1, b: undefined }), canonicalValue({ a: 1 }));
        assert.notStrictEqual(canonicalValue({ a: 1, b: null }), canonicalValue({ a: 1 }));
    });

    it('accepts a null-prototype object and a frozen object as plain', function () {
        const bare = Object.create(null);
        bare.k = 2;
        assert.strictEqual(canonicalValue(bare), '{"k":2}');
        assert.strictEqual(canonicalValue(Object.freeze({ k: 2 })), '{"k":2}');
    });

    it('distinguishes NOT YET PINNED (null) from an unarmed sentinel height', function () {
        assert.notStrictEqual(canonicalValue({ 'BTC:testnet': null }),
            canonicalValue({ 'BTC:testnet': 9999999999 }));
    });
});

describe('armed_map/canonical: refusals', function () {

    const REFUSED = [
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['undefined at the top level', undefined],
        ['BigInt', BigInt(1)],
        ['function', function f() {}],
        ['symbol', Symbol('s')],
        ['Map', new Map([['a', 1]])],
        ['Set', new Set([1])],
        ['Date', new Date(0)],
        ['class instance', new Height()],
        ['boxed number', Object(1)],
        ['function nested in a data value', { mainnet: 1, check: () => true }],
        ['non-finite number nested in an array', [1, NaN]],
        ['undefined array element', [1, undefined]],
    ];

    for (const [label, value] of REFUSED) {
        it('refuses ' + label + ' with ArmedMapCanonicalError', function () {
            assert.throws(() => canonicalValue(value), (e) => e instanceof ArmedMapCanonicalError);
        });
    }

    it('names where inside the value the refused type sits', function () {
        assert.throws(() => canonicalValue({ outer: { inner: [0, new Map()] } }),
            (e) => e instanceof ArmedMapCanonicalError && e.message.includes('$.outer.inner[1]'));
    });
});

describe('armed_map/canonical: keys and preimage', function () {

    it('accepts every key shape the indexer uses today', function () {
        for (const key of ['state_commitment_activation.STATE_COMMITMENT_ACTIVATION',
            'stateHash.DEACTIVATION_TABLES', 'protocol/constants.XBRIDGE_MAX_PER_BLOCK',
            'attestation/providerMinStakeHistory.PROVIDER_MIN_STAKE_ACTIVATIONS',
            'protocol_changes.changes.ADDRESS', 'consensus-constants.GAS_TICK']) {
            assert.ok(KEY_RE.test(key), key);
        }
    });

    it('refuses a key outside the grammar', function () {
        for (const key of ['nodot', 'a.', '.A', 'a..B', 'a.B-C', 'a b.C', 'a.B C', 'é.X', '', 'a.B\n']) {
            assert.throws(() => preimage([[key, 1]]), (e) => e instanceof ArmedMapCanonicalError, JSON.stringify(key));
        }
        assert.throws(() => preimage([[42, 1]]), ArmedMapCanonicalError);
    });

    it('refuses a duplicate key rather than letting the last one win', function () {
        assert.throws(() => preimage([['a.X', 1], ['a.X', 1]]),
            (e) => e instanceof ArmedMapCanonicalError && e.message.includes('a.X'));
    });

    it('refuses a malformed rows argument', function () {
        assert.throws(() => preimage({}), ArmedMapCanonicalError);
        assert.throws(() => preimage([['a.X']]), ArmedMapCanonicalError);
        assert.throws(() => preimage([['a.X', 1, 2]]), ArmedMapCanonicalError);
    });

    it('prefixes the domain and sorts rows by key in code-unit order', function () {
        assert.strictEqual(DOMAIN, 'xchain-armed-map/v2\n');
        const text = preimage([['b.X', { t: 1 }], ['a.Y', null], ['a.X', /r/]]);
        assert.strictEqual(text, 'xchain-armed-map/v2\na.X=re:"r":""\na.Y=null\nb.X={"t":1}\n');
    });

    it('is independent of row order and names the refused row', function () {
        const rows = [['b.X', 2], ['a.X', 1]];
        assert.strictEqual(preimage(rows), preimage(rows.slice().reverse()));
        assert.throws(() => preimage([['a.X', 1], ['b.X', new Set()]]),
            (e) => e instanceof ArmedMapCanonicalError && e.message.startsWith('b.X:'));
    });
});

describe('armed_map/canonical: fingerprint', function () {

    it('hashes the preimage and each row value, and counts rows', function () {
        const rows = [['b.X', { t: 1 }], ['a.X', 145000]];
        const out = fingerprint(rows);
        assert.strictEqual(out.hex, sha('xchain-armed-map/v2\na.X=145000\nb.X={"t":1}\n'));
        assert.deepStrictEqual(out.rows, { 'a.X': sha('145000'), 'b.X': sha('{"t":1}') });
        assert.deepStrictEqual(Object.keys(out.rows), ['a.X', 'b.X']);
        assert.strictEqual(out.count, 2);
    });

    it('moves when one value moves, including null to a sentinel height', function () {
        const base = fingerprint([['g.A', { 'BTC:testnet': 145000 }], ['g.B', { 'BTC:testnet': null }]]).hex;
        assert.notStrictEqual(base, fingerprint([['g.A', { 'BTC:testnet': 145001 }], ['g.B', { 'BTC:testnet': null }]]).hex);
        assert.notStrictEqual(base, fingerprint([['g.A', { 'BTC:testnet': 145000 }], ['g.B', { 'BTC:testnet': 9999999999 }]]).hex);
    });

    it('requires nothing but crypto, so the same bytes serve the sync twin', function () {
        const src = require('fs').readFileSync(require.resolve('../../../../src/consensus/armed_map/canonical.js'), 'utf8');
        const specs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
        assert.deepStrictEqual(specs, ['crypto']);
    });
});

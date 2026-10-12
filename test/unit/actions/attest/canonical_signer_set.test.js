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
// The canonical signer-set rule on the responsible_set part: the first
// `redundancy` verified signers in responsible-set rank order, sorted by pubkey.

'use strict';

const assert = require('assert');
const part = require('../../../../src/actions/attest/responsible_set.js');

const s = k => ({ pubkey: k, sig: 's' + k });
const pks = list => list.map(x => x.pubkey);

describe('canonicalSignerSet', function(){
    it('gives one result for two insertion orders of one set', function(){
        let ranked = ['dd', 'bb', 'aa', 'cc'];
        let a = part.canonicalSignerSet([s('cc'), s('aa'), s('bb'), s('dd')], ranked, 2);
        let b = part.canonicalSignerSet([s('dd'), s('bb'), s('aa'), s('cc')], ranked, 2);
        assert.deepStrictEqual(a, b);
        assert.deepStrictEqual(pks(a), ['bb', 'dd']);
    });

    it('agrees on a and b for verified sets {a,b,c} and {a,b,d} at redundancy 2', function(){
        let ranked = ['a', 'b', 'c', 'd'];
        let x = part.canonicalSignerSet([s('a'), s('b'), s('c')], ranked, 2);
        let y = part.canonicalSignerSet([s('d'), s('b'), s('a')], ranked, 2);
        assert.deepStrictEqual(pks(x), ['a', 'b']);
        assert.deepStrictEqual(x, y);
    });

    it('drops a non-member and counts a duplicate once at its first entry', function(){
        let out = part.canonicalSignerSet(
            [{ pubkey: 'zz', sig: 'sz' }, { pubkey: 'aa', sig: 'first' }, { pubkey: 'AA', sig: 'second' }, s('bb')],
            ['aa', 'bb'], 2);
        assert.deepStrictEqual(out, [{ pubkey: 'aa', sig: 'first' }, { pubkey: 'bb', sig: 'sbb' }]);
    });

    it('lower-cases pubkeys on both sides', function(){
        let out = part.canonicalSignerSet([{ pubkey: 'AB', sig: 'x' }], ['aB'], 1);
        assert.deepStrictEqual(out, [{ pubkey: 'ab', sig: 'x' }]);
    });

    it('returns what qualifies when the set is short', function(){
        assert.deepStrictEqual(pks(part.canonicalSignerSet([s('aa')], ['aa', 'bb', 'cc'], 3)), ['aa']);
        assert.deepStrictEqual(part.canonicalSignerSet([], ['aa'], 2), []);
    });

    it('mutates neither input and returns new objects', function(){
        let sigs = [s('bb'), s('aa')];
        let ranked = ['bb', 'aa'];
        let sigsCopy = JSON.stringify(sigs);
        let out = part.canonicalSignerSet(sigs, ranked, 2);
        assert.strictEqual(JSON.stringify(sigs), sigsCopy);
        assert.deepStrictEqual(ranked, ['bb', 'aa']);
        assert.notStrictEqual(out[0], sigs[1]);
    });
});

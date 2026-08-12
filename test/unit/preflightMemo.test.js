// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PreflightMemo LRU unit suite: bounded, height-keyed, LRU
// eviction, and key construction. Pure - no DB, no dlopen.

const assert = require('assert');
const PreflightMemo = require('../../src/preflightMemo.js');

describe('PreflightMemo @regression', function () {

    it('keys include action, params, source, and blockIndex', function () {
        let m = new PreflightMemo();
        let k1 = m.key('SEND', ['0', 'JDOG', '1', 'a'], 'src', 100);
        let k2 = m.key('SEND', '0|JDOG|1|a', 'src', 100);
        assert.strictEqual(k1, k2, 'array and string params must key identically');
        assert.notStrictEqual(k1, m.key('SEND', '0|JDOG|1|a', 'src', 101), 'a new height is a new key');
        assert.notStrictEqual(k1, m.key('SEND', '0|JDOG|1|a', 'other', 100), 'a new source is a new key');
    });

    it('get/set round-trips and returns null on miss', function () {
        let m = new PreflightMemo();
        assert.strictEqual(m.get('x'), null);
        m.set('x', { valid: true });
        assert.deepStrictEqual(m.get('x'), { valid: true });
    });

    it('evicts the oldest entry past the cap', function () {
        let m = new PreflightMemo(3);
        m.set('a', 1); m.set('b', 2); m.set('c', 3);
        m.set('d', 4); // evicts 'a'
        assert.strictEqual(m.get('a'), null);
        assert.strictEqual(m.get('d'), 4);
        assert.strictEqual(m.size, 3);
    });

    it('a get() touches recency so it survives eviction', function () {
        let m = new PreflightMemo(3);
        m.set('a', 1); m.set('b', 2); m.set('c', 3);
        m.get('a');    // touch 'a' -> now newest
        m.set('d', 4); // evicts 'b' (now oldest), not 'a'
        assert.strictEqual(m.get('a'), 1);
        assert.strictEqual(m.get('b'), null);
    });

    it('clear empties the memo', function () {
        let m = new PreflightMemo();
        m.set('a', 1);
        m.clear();
        assert.strictEqual(m.size, 0);
        assert.strictEqual(m.get('a'), null);
    });
});

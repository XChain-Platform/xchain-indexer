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
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const {
    policyHash,
    isListRef,
    parseMembership,
    parseMembershipOrRef,
} = require('../../../../src/consensus/bridge_settle/policy_membership.js');

const ADDR_A = 'nAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = 'nBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR_C = 'nCcccccccccccccccccccccccccccccccc';
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

describe('policy membership references', function(){

    it('keeps the legacy policy hash vectors byte-identical', function(){
        assert.strictEqual(policyHash(null, null, false),
            'fbf0a3d750d94d72b3d72b7a439c8480482291706bcfd0a3091b09738720c55a');
        assert.strictEqual(policyHash([], null, false),
            '475306e714794247e7c7e4c3e250a58059cf98d151ca91eae17b4bb54c9d3e6a');
        assert.strictEqual(policyHash([ADDR_A, ADDR_B], [ADDR_C], false),
            '39a59aa3151ec050002f599ffa4ab2a6a4466c3b508082d83653063a8100e945');
        assert.strictEqual(policyHash(null, null, true),
            '679fb7853b9ee54a3dd488cedda3d91e484255c831dd4464b2a02bf2a3326587');
        assert.strictEqual(policyHash(null, null, false, { allow: null, block: null }),
            'fbf0a3d750d94d72b3d72b7a439c8480482291706bcfd0a3091b09738720c55a');
    });

    it('hashes a ref in place of the section count and members', function(){
        assert.strictEqual(
            policyHash([ADDR_A], null, false, { allow: 'DOGE:2701' }),
            sha('ALLOW|REF|DOGE:2701|BLOCK|-|SLEEP|0'));
        assert.strictEqual(
            policyHash(null, [ADDR_C], true, { block: 'BTC:9' }),
            sha('ALLOW|-|BLOCK|REF|BTC:9|SLEEP|1'));
        assert.strictEqual(
            policyHash([], [], false, { allow: 'LTC:1', block: 'DOGE:2' }),
            sha('ALLOW|REF|LTC:1|BLOCK|REF|DOGE:2|SLEEP|0'));
    });

    it('recognizes only canonical positive list references', function(){
        for(const value of ['BTC:1', 'LTC:42', 'DOGE:2701', 'BTC:999999999999999999999'])
            assert.strictEqual(isListRef(value), true, value);
        for(const value of [
            'BTC:0', 'BTC:01', 'BTC:-1', 'BTC:1.0', 'btc:1', 'ETH:1',
            'DOGE:', 'DOGE: 1', ' DOGE:1', 'DOGE:1 ', 'DOGE::1', '', null, 1,
        ]) assert.strictEqual(isListRef(value), false, String(value));
    });

    it('separates member arrays, refs and null transport values', function(){
        assert.deepStrictEqual(parseMembershipOrRef('["alpha",2]'), { list: ['alpha', '2'] });
        assert.deepStrictEqual(parseMembershipOrRef(['alpha', 2]), { list: ['alpha', '2'] });
        assert.deepStrictEqual(parseMembershipOrRef('"DOGE:2701"'), { ref: 'DOGE:2701' });
        assert.deepStrictEqual(parseMembershipOrRef(null), { list: null });
        assert.deepStrictEqual(parseMembershipOrRef('null'), { list: null });
    });

    it('refuses malformed transport and non-reference JSON strings', function(){
        for(const value of [
            undefined, 'not json', '"DOGE:02701"', '"ETH:1"', '{}', '1', 'true',
        ]) assert.strictEqual(parseMembershipOrRef(value), false, String(value));
    });

    it('leaves the legacy membership parser unchanged', function(){
        assert.deepStrictEqual(parseMembership(undefined), null);
        assert.deepStrictEqual(parseMembership('["alpha",2]'), ['alpha', '2']);
        assert.strictEqual(parseMembership('"DOGE:2701"'), false);
    });
});

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * Canonical parsing boundaries shared by the JSON-RPC read handlers.
 */

'use strict';

const assert = require('assert');
const rpcParams = require('../../../../src/api/rpc/params.js');

describe('JSON-RPC scalar parameters @regression @tier1', function () {
    it('accepts the integer forms emitted by hub and explorer callers', function () {
        assert.deepStrictEqual(rpcParams.integer(40, { name: 'block_index', min: 0 }), { value: 40 });
        assert.deepStrictEqual(rpcParams.integer('40', { name: 'block_index', min: 0 }), { value: 40 });
        assert.deepStrictEqual(rpcParams.optionalInteger(undefined, { name: 'after_action_index', min: 1 }),
            { value: undefined });
    });

    it('rejects coercible, fractional, negative and inexact integer inputs', function () {
        for(const value of ['', '01', '1e2', ' 1', true, [1], 1.5, -1, Number.MAX_SAFE_INTEGER + 1]){
            assert.deepStrictEqual(rpcParams.integer(value, { name: 'block_index', min: 0 }),
                { error: 'block_index must be a non-negative integer' }, JSON.stringify(value));
        }
        assert.deepStrictEqual(rpcParams.integer(0, { name: 'action_index', min: 1 }),
            { error: 'action_index must be a positive integer' });
    });

    it('defaults and caps page sizes while refusing malformed explicit limits', function () {
        assert.deepStrictEqual(rpcParams.limit(undefined, { defaultValue: 100, max: 500 }), { value: 100 });
        assert.deepStrictEqual(rpcParams.limit(9999, { defaultValue: 100, max: 500 }), { value: 500 });
        for(const value of [0, -1, 1.5, '1e2', Number.MAX_SAFE_INTEGER + 1])
            assert.deepStrictEqual(rpcParams.limit(value, { defaultValue: 100, max: 500 }),
                { error: 'limit must be a positive integer' });
    });

    it('accepts real caller strings and refuses wrong types or oversized values', function () {
        assert.deepStrictEqual(rpcParams.string('attestation', { name: 'capability', maxLength: 64 }),
            { value: 'attestation' });
        assert.deepStrictEqual(rpcParams.string(undefined, { name: 'provider_id', maxLength: 255 }),
            { value: undefined });
        assert.deepStrictEqual(rpcParams.string(7, { name: 'provider_id', maxLength: 255 }),
            { error: 'provider_id must be a string of at most 255 characters' });
        assert.deepStrictEqual(rpcParams.string('x'.repeat(256), { name: 'provider_id', maxLength: 255 }),
            { error: 'provider_id must be a string of at most 255 characters' });
        assert.deepStrictEqual(rpcParams.string('', { name: 'tick', maxLength: 255, required: true }),
            { error: 'tick must be a string of at most 255 characters' });
    });

    it('accepts configured stake thresholds and refuses non-canonical decimals', function () {
        assert.deepStrictEqual(rpcParams.decimal('1000.00000000', { name: 'min_stake' }),
            { value: '1000.00000000' });
        assert.deepStrictEqual(rpcParams.decimal(5000, { name: 'min_stake' }), { value: 5000 });
        for(const value of [-1, '1e3', '1.', {}, '1'.repeat(81)])
            assert.deepStrictEqual(rpcParams.decimal(value, { name: 'min_stake' }),
                { error: 'min_stake must be a non-negative decimal' });
    });
});

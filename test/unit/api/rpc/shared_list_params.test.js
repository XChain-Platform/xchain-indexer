/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const {
    parseSharedListParams,
    sharedListRecord
} = require('../../../../src/api/rpc/shared_list/params.js');

describe('shared list params', function () {
    it('accepts each supported home chain exactly as an upper-case string', function () {
        for(const home_chain of ['BTC', 'LTC', 'DOGE'])
            assert.deepStrictEqual(parseSharedListParams({ home_chain, list_index: 12 }), {
                home_chain,
                list_index: 12
            });
    });

    it('rejects unsupported, lower-case, null, and non-object parameter values', function () {
        const error = { error: 'home_chain must be BTC, LTC or DOGE' };

        assert.deepStrictEqual(parseSharedListParams({ home_chain: 'ETH', list_index: 1 }), error);
        assert.deepStrictEqual(parseSharedListParams({ home_chain: 'btc', list_index: 1 }), error);
        assert.deepStrictEqual(parseSharedListParams(null), error);
        assert.deepStrictEqual(parseSharedListParams('BTC'), error);
    });

    it('normalizes a canonical decimal list index string', function () {
        assert.deepStrictEqual(parseSharedListParams({ home_chain: 'BTC', list_index: '7' }), {
            home_chain: 'BTC',
            list_index: 7
        });
    });

    it('rejects every non-positive, non-integer, non-canonical, or unsafe list index', function () {
        const error = { error: 'list_index must be a positive integer' };
        const invalid = [
            0,
            -1,
            1.5,
            '01',
            'x',
            null,
            undefined,
            Number.MAX_SAFE_INTEGER + 1,
            String(Number.MAX_SAFE_INTEGER + 1)
        ];

        for(const list_index of invalid)
            assert.deepStrictEqual(parseSharedListParams({ home_chain: 'LTC', list_index }), error);
    });

    it('returns the exact record shape with a cloned utf8 byte-sorted member array', function () {
        const members = ['b', 'B', 'a'];
        const record = sharedListRecord({
            home_chain: 'BTC',
            home_list_index: 5,
            local_list_index: 9,
            seq: 2,
            origin_block: 100,
            members
        });

        assert.deepStrictEqual(record, {
            home_chain: 'BTC',
            home_list_index: 5,
            local_list_index: 9,
            seq: 2,
            origin_block: 100,
            members: ['B', 'a', 'b']
        });
        assert.deepStrictEqual(Object.keys(record), [
            'home_chain',
            'home_list_index',
            'local_list_index',
            'seq',
            'origin_block',
            'members'
        ]);
        assert.deepStrictEqual(members, ['b', 'B', 'a']);
        assert.notStrictEqual(record.members, members);
    });
});

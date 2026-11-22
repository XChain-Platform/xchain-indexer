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
const Utility = require('../../../src/utility.js');
const { assertCommittedLeaves } = require('../../../src/state_commitment/touch_guards.js');

describe('leaf-presence batch read @regression', function(){
    it('reads all absent leaves in one statement and preserves failure order', async function(){
        const keys = new Set(['a1\tTICK', 'a2\tTICK', 'a3\tTICK']);
        const calls = [];
        const db = {
            util: new Utility({}),
            doQueryStrict: async (sql, params) => {
                calls.push({ sql, params });
                return [
                    { i: 0, cr: '1000', dr: '0' },
                    { i: 1, cr: '0', dr: '0' },
                    { i: 2, cr: '7', dr: '0' }
                ];
            }
        };
        const smt = { prove: async () => ({ leaf_value: null }) };

        await assert.rejects(
            () => assertCommittedLeaves(db, smt, 'BTC', 'regtest', 500, 'root', keys),
            err => {
                assert.match(err.message,
                    /\[\["a1","TICK","1000\.000000000000000000"\],\["a3","TICK","7\.000000000000000000"\]\]/);
                return true;
            });

        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].params,
            ['a1', 'TICK', 'a2', 'TICK', 'a3', 'TICK']);
        assert.match(calls[0].sql, /FROM \(SELECT 0 AS i/);
    });
});

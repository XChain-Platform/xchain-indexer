/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 * A commercial license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * test/unit/price/db_oracle_preload_monotone_key.test.js
 *
 * The preload bound is a monotone key in the admission era: walking blocks upward,
 * the set of readable rounds only grows, whatever the block stamps do. The legacy
 * time bound is not monotone on a chain whose stamps step backward.
 ********************************************************************/

'use strict';

const assert = require('assert');
const { oraclePreloadBound } = require('../../../src/db/prices/oracle_preload_causality_gate.js');

const ROUNDS = [
    { n: 1, ts: 1700000000, admit: null },
    { n: 2, ts: 1700000900, admit: 4903390 },
    { n: 3, ts: 1700000100, admit: 4903410 },
    { n: 4, ts: 1700000500, admit: 4903430 }
];

// Block heights ascending, stamps stepping backward in the middle.
const BLOCKS = [
    { h: 4903400, t: 1700000700 },
    { h: 4903401, t: 1700000200 },
    { h: 4903420, t: 1700000150 },
    { h: 4903440, t: 1700001000 }
];

// Read the rounds a clause admits, evaluating the one OR group the gate emits.
function readable(bound){
    return ROUNDS.filter(r => {
        if(bound.sql === '') return true;
        const [t, h] = bound.args;
        if(/admit_block_ltc IS NULL/.test(bound.sql))
            return r.admit === null ? r.ts <= t : r.admit <= h;
        return r.ts <= t;
    }).map(r => r.n);
}

function isSubset(a, b){ return a.every(x => b.includes(x)); }

describe('preload bound is a monotone key in the admission era @regression @tier1', function(){
    it('the readable set only grows as the height rises, stamps notwithstanding', function(){
        let prev = [];
        for(const b of BLOCKS){
            const cur = readable(oraclePreloadBound(b.h, b.t, 'testnet', 'LTC')).filter(n => n !== 1);
            assert.ok(isSubset(prev, cur), 'rounds with a signed height never drop out as the height rises');
            prev = cur;
        }
    });

    it('rounds with a signed height are selected by height alone', function(){
        const signed = BLOCKS.map(b => readable(oraclePreloadBound(b.h, b.t, 'testnet', 'LTC')).filter(n => n !== 1));
        assert.deepStrictEqual(signed, [[2], [2], [2, 3], [2, 3, 4]]);
        const restamped = BLOCKS.map(b => readable(oraclePreloadBound(b.h, b.t + 100000, 'testnet', 'LTC')).filter(n => n !== 1));
        assert.deepStrictEqual(restamped, signed);
    });

    it('the legacy time bound is not monotone across the same blocks', function(){
        const legacy = BLOCKS.map(b => readable(oraclePreloadBound(4903290, b.t, 'testnet', 'LTC')));
        assert.ok(!isSubset(legacy[0], legacy[1]), 'a backward stamp shrinks the readable set');
    });
});

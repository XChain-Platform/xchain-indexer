'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

const assert = require('assert');
const { planListRematch } = require('../../../src/consensus/list_rematch_plan');

function listData(){
    return {
        SOURCE: 'source-address',
        ACTION: 'LIST',
        BLOCK_INDEX: 150,
        BLOCK_TIME: 200,
        ACTION_INDEX: 25,
        STATUS: 'valid',
        ITEM: ['listed-address']
    };
}

describe('list_rematch_plan', function () {
    it('merges unsorted orders and swaps in ascending action-index order', function () {
        const plan = planListRematch(listData(), [41, 11, 31], [21, 1]);

        assert.deepStrictEqual(plan.map(({ action, data }) => ({
            action,
            index: data.ORDER_ACTION_INDEX ?? data.SWAP_ACTION_INDEX
        })), [
            { action: 'SWAP_MATCH', index: 1 },
            { action: 'ORDER_MATCH', index: 11 },
            { action: 'SWAP_MATCH', index: 21 },
            { action: 'ORDER_MATCH', index: 31 },
            { action: 'ORDER_MATCH', index: 41 }
        ]);
    });

    it('copies all list fields and sets only the index key for each match kind', function () {
        const source = listData();
        const plan = planListRematch(source, [7], [9]);

        assert.deepStrictEqual(plan, [
            { action: 'ORDER_MATCH', data: { ...source, ORDER_ACTION_INDEX: 7 } },
            { action: 'SWAP_MATCH', data: { ...source, SWAP_ACTION_INDEX: 9 } }
        ]);
        assert.strictEqual(Object.hasOwn(plan[0].data, 'SWAP_ACTION_INDEX'), false);
        assert.strictEqual(Object.hasOwn(plan[1].data, 'ORDER_ACTION_INDEX'), false);
    });

    it('gives every entry independent data that cannot leak handler writes', function () {
        const source = listData();
        const plan = planListRematch(source, [3, 1], [2]);

        for(const entry of plan) assert.notStrictEqual(entry.data, source);
        for(let i = 0; i < plan.length; i++)
            for(let j = i + 1; j < plan.length; j++)
                assert.notStrictEqual(plan[i].data, plan[j].data);

        plan[0].data.STATUS = 'invalid: match failed';
        plan[0].data.ACTION_INDEX = 999;

        assert.strictEqual(source.STATUS, 'valid');
        assert.strictEqual(source.ACTION_INDEX, 25);
        assert.deepStrictEqual(plan.slice(1).map(({ data }) => data.STATUS), ['valid', 'valid']);
        assert.deepStrictEqual(plan.slice(1).map(({ data }) => data.ACTION_INDEX), [25, 25]);
    });

    it('emits a repeated index only once within each input', function () {
        const plan = planListRematch(listData(), [8, 8, 8], [4, 4]);

        assert.deepStrictEqual(plan.map(({ action, data }) => [
            action,
            data.ORDER_ACTION_INDEX ?? data.SWAP_ACTION_INDEX
        ]), [
            ['SWAP_MATCH', 4],
            ['ORDER_MATCH', 8]
        ]);
    });

    it('returns an empty plan for empty inputs', function () {
        assert.deepStrictEqual(planListRematch(listData(), [], []), []);
    });
});

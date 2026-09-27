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

const {
    assert, BS, makeKey, snapshotSet,
    COPY, ADDR_A, ADDR_B, ADDR_C, makeSnapshot, makeCtx,
} = require('./helpers/setup.js');

const ALLOW_LIST_INDEX = 42;

// LIST wire constants (actions/list.js, mirrored in bridge_settle/reasons.js): type 2 is an
// ADDRESS list, edit 1 is ADD and edit 2 is REMOVE.
const LIST_TYPE_ADDRESS = '2';
const LIST_EDIT_ADD     = '1';
const LIST_EDIT_REMOVE  = '2';

function copyTokens(overrides){
    return { [COPY]: Object.assign({ TICK_ID: 11, DECIMALS: 2, ALLOW_LIST: null, BLOCK_LIST: null }, overrides) };
}

describe('policy apply: attach half of bridged list convergence', function(){
    it('a null allow list creates the list and points the copy at it, nothing for block', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row  = makeSnapshot(keys, { allow: [ADDR_A, ADDR_B] });
        const { ctx, state } = makeCtx({ validators: snapshotSet(keys), tokens: copyTokens() });

        const res = await BS.applyPolicySnapshot(row, ctx);
        assert.strictEqual(res.applied, true, res.reason || '');
        assert.strictEqual(state.injected.length, 2,
            'one LIST create and one ISSUE 5, nothing injected for the null block list');

        assert.strictEqual(state.injected[0].vout, BS.POLICY_LEG_ORDINAL.ALLOW_CREATE_OR_REMOVE);
        assert.strictEqual(state.injected[0].data, ['LIST', '0', LIST_TYPE_ADDRESS, '', ADDR_A, ADDR_B].join('|'));

        assert.strictEqual(state.injected[1].vout, BS.POLICY_LEG_ORDINAL.ISSUE_POINT);
        assert.strictEqual(state.injected[1].data,
            ['ISSUE', '5', COPY, String(res.actionIndexes[0]), ''].join('|'));
    });
});

describe('policy apply: edit half of bridged list convergence', function(){
    it('an existing allow list moves to new membership with no ISSUE 5', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row  = makeSnapshot(keys, { allow: [ADDR_B, ADDR_C], row: { policy_seq: 2 } });
        const { ctx, state } = makeCtx({
            validators: snapshotSet(keys),
            tokens:     copyTokens({ ALLOW_LIST: ALLOW_LIST_INDEX }),
            lists:      { [ALLOW_LIST_INDEX]: [ADDR_A, ADDR_B] },
        });

        const res = await BS.applyPolicySnapshot(row, ctx);
        assert.strictEqual(res.applied, true, res.reason || '');
        assert.strictEqual(state.injected.length, 2, 'a remove and an add, never an ISSUE 5');

        assert.strictEqual(state.injected[0].vout, BS.POLICY_LEG_ORDINAL.ALLOW_CREATE_OR_REMOVE);
        assert.strictEqual(state.injected[0].data,
            ['LIST', '1', LIST_EDIT_REMOVE, String(ALLOW_LIST_INDEX), '', ADDR_A].join('|'));

        assert.strictEqual(state.injected[1].vout, BS.POLICY_LEG_ORDINAL.ALLOW_ADD);
        assert.strictEqual(state.injected[1].data,
            ['LIST', '1', LIST_EDIT_ADD, String(ALLOW_LIST_INDEX), '', ADDR_C].join('|'));

        assert.ok(!state.injected.some(tx => tx.data.startsWith('ISSUE')), 'an edit never moves the pointer');
    });
});

describe('policy apply: unchanged halves of bridged list convergence', function(){
    it('membership already equal to the origin injects nothing', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row  = makeSnapshot(keys, { allow: [ADDR_A, ADDR_B], row: { policy_seq: 2 } });
        const { ctx, state } = makeCtx({
            validators: snapshotSet(keys),
            tokens:     copyTokens({ ALLOW_LIST: ALLOW_LIST_INDEX }),
            lists:      { [ALLOW_LIST_INDEX]: [ADDR_A, ADDR_B] },
        });

        const res = await BS.applyPolicySnapshot(row, ctx);
        assert.strictEqual(res.applied, true, res.reason || '');
        assert.deepStrictEqual(state.injected, []);
    });

    it('a null allow list against a copy with no allow list injects nothing for that list', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row  = makeSnapshot(keys, { allow: null });
        const { ctx, state } = makeCtx({ validators: snapshotSet(keys), tokens: copyTokens() });

        const res = await BS.applyPolicySnapshot(row, ctx);
        assert.strictEqual(res.applied, true, res.reason || '');
        assert.deepStrictEqual(state.injected, []);
    });
});

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

const sinon = require('sinon');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const {
    assert, BS, makeKey, snapshotSet,
    COPY, ADDR_A, ADDR_B, ADDR_C, makeSnapshot, makeCtx,
} = require('./helpers/setup.js');

const DETACH_GATE = 'bridge_policy_detach_activation.BRIDGE_POLICY_DETACH';
const ALLOW_LIST_INDEX = 4242;
const BLOCK_LIST_INDEX = 4343;

function copyTokens(overrides){
    return { [COPY]: Object.assign({
        TICK_ID: 11, DECIMALS: 2, ALLOW_LIST: null, BLOCK_LIST: null
    }, overrides) };
}

function pointedLists(){
    return {
        tokens: copyTokens({ ALLOW_LIST: ALLOW_LIST_INDEX, BLOCK_LIST: BLOCK_LIST_INDEX }),
        lists: { [ALLOW_LIST_INDEX]: [ADDR_A], [BLOCK_LIST_INDEX]: [ADDR_B] },
    };
}

describe('policy apply: detach bridged policy lists', function(){
    afterEach(function(){ sinon.restore(); });

    it('detaches both pointed lists with one ISSUE 5 leg', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeSnapshot(keys, { allow: null, block: null });
        const existing = pointedLists();
        const { ctx, state } = makeCtx({
            validators: snapshotSet(keys), tokens: existing.tokens, lists: existing.lists,
        });

        const res = await BS.applyPolicySnapshot(row, ctx);
        assert.strictEqual(res.applied, true, res.reason || '');
        assert.strictEqual(state.injected.length, 1);
        assert.strictEqual(state.injected[0].vout, BS.POLICY_LEG_ORDINAL.ISSUE_POINT);
        assert.deepStrictEqual(state.injected[0].data.split('|'), ['ISSUE', '5', COPY, '0', '0']);
    });

    it('detaches allow while leaving an unchanged block pointer inherited', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeSnapshot(keys, { allow: null, block: [ADDR_B] });
        const existing = pointedLists();
        const { ctx, state } = makeCtx({
            validators: snapshotSet(keys), tokens: existing.tokens, lists: existing.lists,
        });

        const res = await BS.applyPolicySnapshot(row, ctx);
        assert.strictEqual(res.applied, true, res.reason || '');
        assert.strictEqual(state.injected.length, 1);
        assert.strictEqual(state.injected[0].vout, BS.POLICY_LEG_ORDINAL.ISSUE_POINT);
        assert.deepStrictEqual(state.injected[0].data.split('|'), ['ISSUE', '5', COPY, '0', '']);
    });

    it('detaches allow and creates the missing block list before pointing both', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeSnapshot(keys, { allow: null, block: [ADDR_C] });
        const { ctx, state } = makeCtx({
            validators: snapshotSet(keys),
            tokens: copyTokens({ ALLOW_LIST: ALLOW_LIST_INDEX }),
            lists: { [ALLOW_LIST_INDEX]: [ADDR_A] },
        });

        const res = await BS.applyPolicySnapshot(row, ctx);
        assert.strictEqual(res.applied, true, res.reason || '');
        assert.strictEqual(state.injected.length, 2);
        assert.strictEqual(state.injected[0].vout, BS.POLICY_LEG_ORDINAL.BLOCK_CREATE_OR_REMOVE);
        assert.strictEqual(state.injected[0].data, ['LIST', '0', '2', '', ADDR_C].join('|'));
        assert.strictEqual(state.injected[1].vout, BS.POLICY_LEG_ORDINAL.ISSUE_POINT);
        assert.deepStrictEqual(state.injected[1].data.split('|'),
            ['ISSUE', '5', COPY, '0', String(res.actionIndexes[0])]);
    });
});

describe('policy apply: detach gate boundaries', function(){
    afterEach(function(){ sinon.restore(); });

    it('keeps pointed lists attached below the detach gate', async function(){
        const originalActiveAt = gateRegistry.activeAt;
        sinon.stub(gateRegistry, 'activeAt').callsFake(function(name, ...args){
            if(name === DETACH_GATE) return false;
            return originalActiveAt.call(gateRegistry, name, ...args);
        });
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeSnapshot(keys, { allow: null, block: null });
        const existing = pointedLists();
        const { ctx, state } = makeCtx({
            validators: snapshotSet(keys), tokens: existing.tokens, lists: existing.lists,
        });

        const res = await BS.applyPolicySnapshot(row, ctx);
        assert.strictEqual(res.applied, true, res.reason || '');
        assert.deepStrictEqual(state.injected, []);
        assert.strictEqual(gateRegistry.activeAt.callCount, 1);
        assert.deepStrictEqual(gateRegistry.activeAt.firstCall.args,
            [DETACH_GATE, 'regtest', 'DOGE', 900, null]);
    });

    it('injects nothing when null lists have no pointers to detach', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeSnapshot(keys, { allow: null, block: null });
        const { ctx, state } = makeCtx({
            validators: snapshotSet(keys), tokens: copyTokens(),
        });

        const res = await BS.applyPolicySnapshot(row, ctx);
        assert.strictEqual(res.applied, true, res.reason || '');
        assert.deepStrictEqual(state.injected, []);
    });
});

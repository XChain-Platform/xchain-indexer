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

const sinon = require('sinon');
const { stubActiveAt } = require('../../helpers/gate_modules.js');
const {
    assert, BS, XPOLICY_MAX_PER_BLOCK, makeKey, snapshotSet, makeSnapshot, makeCtx,
    ORIGIN, COPY, BRIDGE_BTC_ON_DOGE, ADDR_A, ADDR_B,
} = require('../bridge/policy_apply.test/helpers/setup.js');

const CONSUMER_GATE = 'list_share_consumer_activation.LIST_SHARE_CONSUMER_ACTIVATION';

function makeRefSnapshot(keys, ref){
    return makeSnapshot(keys, { row: {
        allow_list: JSON.stringify(ref),
        policy_hash: BS.policyHash(null, null, false, { allow: ref }),
    }});
}

function dueRow(id, tick, seq, ref){
    return {
        snapshot_id: id, snapshot_block: 10, origin_chain: ORIGIN, tick, policy_seq: seq,
        allow_list: ref ? JSON.stringify(ref) : null, block_list: null,
    };
}

describe('policy apply by shared-list reference', function(){
    afterEach(function(){ sinon.restore(); });

    it('points a copy at a foreign mirror with one ISSUE 5 leg and no LIST leg', async function(){
        stubActiveAt(sinon, CONSUMER_GATE, true);
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeRefSnapshot(keys, 'BTC:77');
        const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
        ctx.indexerDb.getListShareMirror = async (chain, index) => {
            assert.strictEqual(chain, 'BTC');
            assert.strictEqual(index, 77);
            return { action_index: '8800' };
        };

        const result = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(result.applied, true, result.reason || '');
        assert.deepStrictEqual(state.injected.map(tx => tx.vout), [BS.POLICY_LEG_ORDINAL.ISSUE_POINT]);
        assert.strictEqual(state.injected[0].data, 'ISSUE|5|' + COPY + '|8800|');
        assert.ok(!state.injected.some(tx => /^LIST\|/.test(tx.data)));
    });

    it('carries an unresolved mirror reference with nothing applied', async function(){
        stubActiveAt(sinon, CONSUMER_GATE, true);
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeSnapshot(keys, { row: {
            allow_list: JSON.stringify('BTC:77'),
            block_list: JSON.stringify('LTC:88'),
            policy_hash: BS.policyHash(null, null, false, { allow: 'BTC:77', block: 'LTC:88' }),
        }});
        const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
        ctx.indexerDb.getListShareMirror = async (chain) =>
            chain === 'BTC' ? { action_index: 8800 } : null;

        const result = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(result.applied, false);
        assert.strictEqual(result.reason, BS.SETTLE_REASON.POLICY_REF_PENDING);
        assert.strictEqual(result.terminal, false);
        assert.deepStrictEqual(result.actionIndexes, []);
        assert.deepStrictEqual(state.injected, []);
        assert.deepStrictEqual(state.settlements, []);
    });

    it('carries refs below the gate and removes their tail before the due-set cap', async function(){
        const gate = stubActiveAt(sinon, CONSUMER_GATE, false);
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeRefSnapshot(keys, 'BTC:77');
        const apply = makeCtx({ validators: snapshotSet(keys) });

        const result = await BS.applyPolicySnapshot(row, apply.ctx);
        assert.strictEqual(result.reason, BS.SETTLE_REASON.POLICY_REF_BEFORE_CONSUMER);
        assert.strictEqual(result.terminal, false);
        assert.deepStrictEqual(apply.state.injected, []);

        const held = Array.from({ length: XPOLICY_MAX_PER_BLOCK + 1 }, (_, i) =>
            dueRow('a' + String(i).padStart(3, '0'), 'HELD', i + 1, i === 0 ? 'BTC:77' : null));
        const other = dueRow('z000', 'OTHER', 1, null);
        const due = makeCtx({ mirrorPolicies: held.concat(other) });
        due.ctx.indexerDb.mirrorDb = () => ({
            getFinalizedPolicySnapshots: async () => held.concat(other),
        });
        due.ctx.indexerDb.getRecordedPolicySettlementIds = async () => [];

        assert.deepStrictEqual((await BS.duePolicySnapshots(due.ctx)).map(r => r.tick), ['OTHER']);
        gate.withArgs(CONSUMER_GATE).returns(true);
        const armed = await BS.duePolicySnapshots(due.ctx);
        assert.strictEqual(armed.length, XPOLICY_MAX_PER_BLOCK);
        assert.ok(armed.every(r => r.tick === 'HELD'));
    });

    it('creates a fresh full-copy list instead of editing a shared pointer', async function(){
        stubActiveAt(sinon, CONSUMER_GATE, true);
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeSnapshot(keys, { allow: [ADDR_A] });
        const { ctx, state } = makeCtx({
            validators: snapshotSet(keys),
            tokens: { [COPY]: { TICK_ID: 11, DECIMALS: 2, ALLOW_LIST: 8800, BLOCK_LIST: null } },
            lists: { '8800': [ADDR_B] },
        });
        ctx.indexerDb.getListShareMirrorByIndex = async () => ({ home_chain: 'BTC', home_list_index: 77 });
        ctx.indexerDb.getListSource = async () => BRIDGE_BTC_ON_DOGE;

        const result = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(result.applied, true, result.reason || '');
        assert.strictEqual(state.injected[0].data, 'LIST|0|2||' + ADDR_A);
        assert.strictEqual(state.injected[0].vout, BS.POLICY_LEG_ORDINAL.ALLOW_CREATE_OR_REMOVE);
        assert.ok(state.injected.some(tx => /^ISSUE\|5\|/.test(tx.data)));
        assert.ok(!state.injected.some(tx => /^LIST\|1\|/.test(tx.data)));
    });

    it('keeps legacy rows byte-identical above and below the consumer gate', async function(){
        const gate = stubActiveAt(sinon, CONSUMER_GATE, false);
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeSnapshot(keys, { allow: [ADDR_A], block: [ADDR_B] });
        const below = makeCtx({ validators: snapshotSet(keys) });
        const belowResult = await BS.applyPolicySnapshot(row, below.ctx);

        gate.withArgs(CONSUMER_GATE).returns(true);
        const above = makeCtx({ validators: snapshotSet(keys) });
        const aboveResult = await BS.applyPolicySnapshot(row, above.ctx);

        assert.strictEqual(belowResult.applied, true);
        assert.strictEqual(aboveResult.applied, true);
        assert.deepStrictEqual(above.state.injected, below.state.injected);
        assert.deepStrictEqual(aboveResult.actionIndexes, belowResult.actionIndexes);
    });
});

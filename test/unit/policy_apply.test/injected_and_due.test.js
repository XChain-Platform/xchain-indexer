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
    assert, crypto, eq, BS, Utility, XPOLICY_MAX_PER_BLOCK,
    bindSettlementReads, makeKey, sign, snapshotSet,
    NETWORK, SNAPSHOT, ORIGIN, NAME, COPY, BRIDGE_BTC_ON_DOGE,
    ADDR_A, ADDR_B, ADDR_C, makeSnapshot, makeCtx,
} = require('./helpers/setup.js');

describe('policy apply: token-policy inheritance onto a bridged copy', function(){
    describe('the injected legs', function(){
        it('injects SLEEP only when the state would change, at its pinned ordinal', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            // Origin says sleeping, the copy is awake: one SLEEP leg with resume_block -1.
            const asleep = makeSnapshot(keys, { sleeping: true });
            const a = makeCtx({ validators: snapshotSet(keys), currentlySleeping: false });
            assert.strictEqual((await BS.applyPolicySnapshot(asleep, a.ctx)).applied, true);
            assert.strictEqual(a.state.injected.length, 1);
            assert.strictEqual(a.state.injected[0].data, 'SLEEP|1|-1|' + COPY);
            assert.strictEqual(a.state.injected[0].vout, BS.POLICY_LEG_ORDINAL.SLEEP);

            // Origin says awake and the copy is already awake: nothing at all.
            const awake = makeSnapshot(keys, { sleeping: false });
            const b = makeCtx({ validators: snapshotSet(keys), currentlySleeping: false });
            assert.strictEqual((await BS.applyPolicySnapshot(awake, b.ctx)).applied, true);
            assert.deepStrictEqual(b.state.injected, []);

            // Origin says awake and the copy is asleep: a wake at the CURRENT block, never the
            // origin's own resume_block (heights are not comparable across chains).
            const wake = makeSnapshot(keys, { sleeping: false, row: { snapshot_id: 'e'.repeat(64) } });
            const c = makeCtx({ validators: snapshotSet(keys), currentlySleeping: true });
            assert.strictEqual((await BS.applyPolicySnapshot(wake, c.ctx)).applied, true);
            assert.strictEqual(c.state.injected[0].data, 'SLEEP|1|900|' + COPY);
        });

        it('records and stops when a leg is REFUSED after another already landed', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { allow: [ADDR_A] });
            // The chain refuses the leg. A refused action still consumes an action index, so a
            // retry would burn a fresh one on every node on every block, forever, and would
            // re-create the list because the pointer that would have revealed it is the leg
            // that failed. The record is what makes that loop impossible.
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys), legStatus: 'invalid: ADDRESS (format)' });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.POLICY_LEG);
            assert.strictEqual(res.terminal, true, 'a retry would duplicate the leg that did land');
            assert.strictEqual(state.settlements.length, 1);
            assert.strictEqual(state.settlements[0].kind, 'policy');

            // And a second pass over the same snapshot injects nothing at all.
            const before = state.injected.length;
            const again  = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(again.reason, BS.SETTLE_REASON.ALREADY_APPLIED);
            assert.strictEqual(state.injected.length, before);
        });
    });
});

describe('policy apply: token-policy inheritance onto a bridged copy', function(){
    describe('the injected legs', function(){
        it('CARRIES a refused leg when nothing landed at all, since a retry duplicates nothing', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { allow: [ADDR_A] });
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
            // A handler that never ran assigns no action index: nothing to duplicate on a retry.
            ctx.actions.processTransaction = async (tx) => { state.injected.push(tx); return undefined; };
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.POLICY_LEG);
            assert.strictEqual(res.terminal, false);
            assert.deepStrictEqual(state.settlements, [], 'nothing landed, so nothing is recorded');
        });

        it('does not apply the snapshot to its own ORIGIN chain', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { row: { origin_chain: 'DOGE' } });
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.POLICY_ORIGIN);
            assert.deepStrictEqual(state.injected, []);
        });
    });
});

describe('policy apply: token-policy inheritance onto a bridged copy', function(){
    describe('idempotency, keyed on (id, kind)', function(){

        // GUARD: the idempotency filter.
        it('injects NOTHING for a snapshot already recorded with kind = policy', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { allow: [ADDR_A] });
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys),
                                             settled: [row.snapshot_id + '|policy'] });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.ALREADY_APPLIED);
            assert.deepStrictEqual(state.injected, []);
        });

        it('is not suppressed by a TRANSFER record carrying the same id', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { allow: [ADDR_A] });
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys),
                                             settled: [row.snapshot_id + '|transfer'] });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.ok(state.injected.length > 0);
        });

        it('records the applied snapshot under kind = policy, anchored to a leg action index', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { allow: [ADDR_A] });
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.strictEqual(state.settlements.length, 1);
            assert.strictEqual(state.settlements[0].kind, 'policy');
            assert.strictEqual(state.settlements[0].transfer_id, row.snapshot_id);
            assert.ok(res.actionIndexes.includes(state.settlements[0].action_index),
                'the record must anchor to an action a reorg can drop');
        });
    });
});

describe('policy apply: token-policy inheritance onto a bridged copy', function(){
    describe('the due set: order and the per-block cap', function(){

        function snapshotRow(id, block, tick, seq){
            return { snapshot_id: id, snapshot_block: block, origin_chain: ORIGIN, tick: tick,
                     policy_seq: seq, network: NETWORK, effective_time: 1, status: 'finalized' };
        }

        // GUARD: the per-block cap.
        it('slices at XPOLICY_MAX_PER_BLOCK and carries the rest forward', async function(){
            const rows = [];
            for(let i = 0; i < XPOLICY_MAX_PER_BLOCK + 3; i++)
                rows.push(snapshotRow(String(i).padStart(64, '0'), 1, 'TICK' + i, 1));
            const { ctx } = makeCtx({ mirrorPolicies: rows });
            const due = await BS.duePolicySnapshots(ctx);
            assert.strictEqual(due.length, XPOLICY_MAX_PER_BLOCK,
                'the cap must bound the slice: ' + due.length + ' of a cap of ' + XPOLICY_MAX_PER_BLOCK);
        });

        it('orders a single tick by policy_seq, never by snapshot_id', async function(){
            // Ids chosen so id order CONTRADICTS seq order: a sort that fell back to the id
            // would apply seq 3 before seq 1 and materialize a stale membership last.
            const rows = [snapshotRow('c'.repeat(64), 1, NAME, 1),
                          snapshotRow('a'.repeat(64), 1, NAME, 3),
                          snapshotRow('b'.repeat(64), 1, NAME, 2)];
            const { ctx } = makeCtx({ mirrorPolicies: rows });
            const due = await BS.duePolicySnapshots(ctx);
            assert.deepStrictEqual(due.map(r => Number(r.policy_seq)), [1, 2, 3]);
        });

        it('orders across ticks by snapshot_id, and never interleaves two ticks', async function(){
            const rows = [snapshotRow('b'.repeat(64), 1, 'ZZZZ', 1),
                          snapshotRow('d'.repeat(64), 1, 'ZZZZ', 2),
                          snapshotRow('a'.repeat(64), 1, 'AAAA', 1),
                          snapshotRow('c'.repeat(64), 1, 'AAAA', 2)];
            const { ctx } = makeCtx({ mirrorPolicies: rows });
            const due = await BS.duePolicySnapshots(ctx);
            assert.deepStrictEqual(due.map(r => r.tick + ':' + r.policy_seq),
                ['AAAA:1', 'AAAA:2', 'ZZZZ:1', 'ZZZZ:2']);
        });

        it('orders by snapshot_block before anything else', async function(){
            const rows = [snapshotRow('a'.repeat(64), 9, 'AAAA', 1),
                          snapshotRow('b'.repeat(64), 2, 'BBBB', 1)];
            const { ctx } = makeCtx({ mirrorPolicies: rows });
            const due = await BS.duePolicySnapshots(ctx);
            assert.deepStrictEqual(due.map(r => Number(r.snapshot_block)), [2, 9]);
        });

        it('drops snapshots already recorded under kind = policy', async function(){
            const rows = [snapshotRow('a'.repeat(64), 1, 'AAAA', 1),
                          snapshotRow('b'.repeat(64), 1, 'BBBB', 1)];
            const { ctx } = makeCtx({ mirrorPolicies: rows, settled: ['a'.repeat(64) + '|policy'] });
            const due = await BS.duePolicySnapshots(ctx);
            assert.deepStrictEqual(due.map(r => r.snapshot_id), ['b'.repeat(64)]);
        });
    });
});


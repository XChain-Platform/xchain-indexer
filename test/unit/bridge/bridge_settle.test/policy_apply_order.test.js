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
 **********************************************************************
 *
 * BRIDGE_POLICY_APPLY_ORDER_ACTIVATION, from the offrail-config lane (2026-10-15).
 *
 *   Cap starvation: every chain reads every policy snapshot, and snapshots for a tick with no
 *   copy here carry forward every block, sort first by snapshot_block and fill the
 *   XPOLICY_MAX_PER_BLOCK cap, so a snapshot for a tick this chain does hold never applies.
 *
 *   Apply order: the order guard checks only the earlier seqs the mirror holds, so seq 2
 *   applies while seq 1 is still in flight and seq 1 then applies last, leaving the copy on
 *   the older membership.
 *
 * Armed, both are fixed; unarmed, the selection and the guard are what they were.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const gateRegistry = require('../../../../src/consensus/gate_registry');
const createPass   = require('../../../../src/consensus/bridge_settle/pass.js');
const {
    BS, makeKey, snapshotSet, makeSnapshot, makeCtx, NETWORK, ORIGIN, NAME, ADDR_A, ADDR_B,
} = require('../policy_apply.test/helpers/setup.js');

// Spelled out rather than imported, so the armed cases read the same against a tree that
// predates the gate and fail on their assertions there.
const KEY = 'bridge_policy_apply_order_activation.BRIDGE_POLICY_APPLY_ORDER_ACTIVATION';
const GAP_BOUND_S = 6600;

function arm(on){
    const orig = gateRegistry.activeAt;
    sinon.stub(gateRegistry, 'activeAt').callsFake(function(name, ...args){
        if(name === KEY) return on;
        return orig.call(gateRegistry, name, ...args);
    });
}

// ── the capped selection (#2) ──────────────────────────────────────────────────────────

function policyRow(tick, seq, snapshotBlock, over){
    return Object.assign({ snapshot_id: (tick + ':' + seq).padEnd(64, '0'), snapshot_block: snapshotBlock,
                           origin_chain: 'BTC', tick: tick, policy_seq: seq, effective_time: 1000,
                           network: 'mainnet', status: 'finalized' }, over || {});
}

// A pass over one LTC block whose mirror holds `rows`, a ledger holding the token rows in
// `copies`, and the due lock in-legs in `inLegs`.
function passFor(rows, o){
    const opts = o || {};
    const copies = new Set(opts.copies || []);
    const seqState = opts.seqState || {};
    const db = {
        mirrorDb: () => ({
            getFinalizedPolicySnapshots: async () => rows.map(r => Object.assign({}, r)),
            getFinalizedBridgeTransfersForChain: async () => (opts.inLegs || []),
        }),
        getRecordedPolicySettlementIds: async () => [],
        getRecordedPolicyRefusalIds: async () => [],
        getTickerId: async (t) => (copies.has(t) ? 7 : null),
        getTokenInfo: async (t) => (copies.has(t) ? { TICK: t } : null),
        getPolicySeqState: async (net, origin, tick) =>
            seqState[origin + '|' + tick] || { appliedSeq: 0, refusedSeqs: [] },
    };
    const deps = { canonicals: { mirrorBindClause: () => ({ sql: '1=1', args: [] }) } };
    const ctx = { network: 'mainnet', coin: 'LTC', blockIndex: 50, blockTime: opts.blockTime || 2000,
                  indexerDb: db, config: {} };
    return { pass: createPass(deps), ctx };
}

const STARVERS = ['QA', 'QB', 'QC', 'QD', 'QE'].map(t => policyRow(t, 1, 5));
const EIGHT = policyRow('EIGHT', 1, 10);
const ids = (rows) => rows.map(r => r.tick + ':' + r.policy_seq);

describe('bridge_settle: policy selection excludes ticks with no copy before the cap @regression', function(){
    afterEach(function(){ sinon.restore(); });

    it('armed: a snapshot for a tick with a copy applies past carried no-copy rows', async function(){
        arm(true);
        const { pass, ctx } = passFor(STARVERS.concat([EIGHT]), { copies: ['BTC.EIGHT'] });
        assert.deepStrictEqual(ids(await pass.duePolicySnapshots(ctx)), ['EIGHT:1']);
    });

    it('unarmed: the five carried no-copy rows still fill the cap, as before', async function(){
        arm(false);
        const { pass, ctx } = passFor(STARVERS.concat([EIGHT]), { copies: ['BTC.EIGHT'] });
        assert.deepStrictEqual(ids(await pass.duePolicySnapshots(ctx)), ['QA:1', 'QB:1', 'QC:1', 'QD:1', 'QE:1']);
    });

    it('armed: re-admits a row once its copy exists, by token row or by a due lock in-leg', async function(){
        arm(true);
        const inLegs = [{ transfer_id: 'f'.repeat(64), src_chain: 'BTC', dest_chain: 'LTC', tick: 'QB', decimals: 8 }];
        const { pass, ctx } = passFor(STARVERS.concat([EIGHT]), { copies: ['BTC.EIGHT', 'BTC.QA'], inLegs: inLegs });
        assert.deepStrictEqual(ids(await pass.duePolicySnapshots(ctx)), ['QA:1', 'QB:1', 'EIGHT:1']);
    });

    it('armed: keeps a row this chain originates, so its own terminal refusal still judges it', async function(){
        arm(true);
        const own = policyRow('MINE', 1, 4, { origin_chain: 'LTC' });
        const { pass, ctx } = passFor([own].concat(STARVERS, [EIGHT]), { copies: ['BTC.EIGHT'] });
        assert.deepStrictEqual(ids(await pass.duePolicySnapshots(ctx)), ['MINE:1', 'EIGHT:1']);
    });
});

describe('bridge_settle: policy selection by contiguous seq @regression', function(){
    afterEach(function(){ sinon.restore(); });

    const s1 = policyRow('EIGHT', 1, 10, { effective_time: 1500 });
    const s2 = policyRow('EIGHT', 2, 10, { effective_time: 1300 });

    it('armed: leaves out a seq whose predecessor is missing, and keeps one that follows it', async function(){
        arm(true);
        let run = passFor([s2], { copies: ['BTC.EIGHT'], blockTime: 1400 });
        assert.deepStrictEqual(ids(await run.pass.duePolicySnapshots(run.ctx)), []);
        run = passFor([s1, s2], { copies: ['BTC.EIGHT'], blockTime: 1500 });
        assert.deepStrictEqual(ids(await run.pass.duePolicySnapshots(run.ctx)), ['EIGHT:1', 'EIGHT:2']);
    });

    it('armed: leaves out a seq at or below the applied one, and admits over a gap past the bound', async function(){
        arm(true);
        const applied = { 'BTC|EIGHT': { appliedSeq: 2, refusedSeqs: [] } };
        let run = passFor([s1], { copies: ['BTC.EIGHT'], blockTime: 9000, seqState: applied });
        assert.deepStrictEqual(ids(await run.pass.duePolicySnapshots(run.ctx)), []);
        const s4 = policyRow('EIGHT', 4, 10, { effective_time: 1300 });
        run = passFor([s4], { copies: ['BTC.EIGHT'], blockTime: 1300 + GAP_BOUND_S - 1, seqState: applied });
        assert.deepStrictEqual(ids(await run.pass.duePolicySnapshots(run.ctx)), [], 'seq 3 may still arrive');
        run = passFor([s4], { copies: ['BTC.EIGHT'], blockTime: 1300 + GAP_BOUND_S, seqState: applied });
        assert.deepStrictEqual(ids(await run.pass.duePolicySnapshots(run.ctx)), ['EIGHT:4']);
        const refused3 = { 'BTC|EIGHT': { appliedSeq: 2, refusedSeqs: [3] } };
        run = passFor([s4], { copies: ['BTC.EIGHT'], blockTime: 1300, seqState: refused3 });
        assert.deepStrictEqual(ids(await run.pass.duePolicySnapshots(run.ctx)), ['EIGHT:4'],
            'a seq recorded refused fills its place');
    });

    it('armed: judges an unsigned huge policy_seq at once, held and then admitted past the bound', async function(){
        arm(true);
        const huge = policyRow('EIGHT', 1e15, 10, { effective_time: 1300 });
        const started = Date.now();
        let run = passFor([huge], { copies: ['BTC.EIGHT'], blockTime: 1300 });
        assert.deepStrictEqual(ids(await run.pass.duePolicySnapshots(run.ctx)), []);
        run = passFor([huge], { copies: ['BTC.EIGHT'], blockTime: 1300 + GAP_BOUND_S });
        assert.deepStrictEqual(ids(await run.pass.duePolicySnapshots(run.ctx)), ['EIGHT:' + 1e15]);
        assert.ok(Date.now() - started < 1000, 'the verdict must not walk the seq range');
    });

    it('armed: a forged huge seq admitted over its gap does not mark the real seq 1 stale', async function(){
        arm(true);
        // Sorted first by snapshot_block, past its bound, and never applied (its signatures fail
        // at the apply, and with no refusal record it is re-read every block).
        const forged = policyRow('EIGHT', 1e15, 3, { effective_time: 1000 });
        const legit  = policyRow('EIGHT', 1, 10, { effective_time: 7000 });
        for(const blockTime of [1000 + GAP_BOUND_S, 1000 + GAP_BOUND_S + 600]){
            const run = passFor([forged, legit], { copies: ['BTC.EIGHT'], blockTime: blockTime });
            assert.deepStrictEqual(ids(await run.pass.duePolicySnapshots(run.ctx)), ['EIGHT:' + 1e15, 'EIGHT:1'],
                'the real seq 1 must stay selected at block time ' + blockTime);
        }
    });

    it('unarmed: the selection ignores seq order, as before', async function(){
        arm(false);
        const run = passFor([s2], { copies: ['BTC.EIGHT'], blockTime: 1400 });
        assert.deepStrictEqual(ids(await run.pass.duePolicySnapshots(run.ctx)), ['EIGHT:2']);
    });
});

// ── the apply's order guard (#3) ───────────────────────────────────────────────────────

// makeCtx's ledger and mirror, extended with the two reads getPolicySeqState issues, so the
// real mixin method runs its shipped SQL against them.
function orderCtx(keys, mirrorPolicies, blockTime){
    const { ctx, state } = makeCtx({ validators: snapshotSet(keys), mirrorPolicies: mirrorPolicies });
    const ledger = ctx.indexerDb.doQuery;
    ctx.indexerDb.doQuery = async (sql, args) => {
        if(/kind IN \('policy', 'refused'\)/.test(sql))
            return [...state.settled].map(k => ({ transfer_id: k.slice(0, k.lastIndexOf('|')), kind: k.slice(k.lastIndexOf('|') + 1) }))
                                     .filter(r => r.kind === 'policy' || r.kind === 'refused');
        return ledger(sql, args);
    };
    const mirror = ctx.indexerDb.mirrorDb;
    ctx.indexerDb.mirrorDb = () => {
        const m = mirror();
        const read = m.doQuery;
        m.doQuery = async (sql, args) => {
            if(/snapshot_id IN/.test(sql) && /policy_seq ASC/.test(sql) && !/LIMIT/.test(sql)){
                const want = new Set(args.slice(3).map(String));
                return state.mirrorPolicies.filter(r => want.has(String(r.snapshot_id)) &&
                    String(r.origin_chain) === String(args[1]) && String(r.tick) === String(args[2]));
            }
            return read(sql, args);
        };
        m.doQueryStrict = m.doQuery;
        return m;
    };
    ctx.blockTime = blockTime;
    return { ctx, state };
}

describe('bridge_settle: policy apply order guard @regression', function(){
    afterEach(function(){ sinon.restore(); });

    const keys = [makeKey(), makeKey(), makeKey()];
    const v1 = makeSnapshot(keys, { allow: [ADDR_A], row: { snapshot_id: '1'.repeat(64), policy_seq: 1, effective_time: 1500 } });
    const v2 = makeSnapshot(keys, { allow: [ADDR_A, ADDR_B], row: { snapshot_id: '2'.repeat(64), policy_seq: 2, effective_time: 1300 } });

    it('armed: holds v2 while v1 is not yet mirrored, then never applies v1 over v2', async function(){
        arm(true);
        // v2 is due and v1 has not reached this mirror: the develop guard saw no earlier seq.
        let run = orderCtx(keys, [v2], 1400);
        let res = await BS.applyPolicySnapshot(v2, run.ctx);
        assert.strictEqual(res.applied, false);
        assert.strictEqual(res.reason, BS.SETTLE_REASON.POLICY_SEQ_GAP);
        assert.strictEqual(res.terminal, false);

        // v2 applied first on a node that skipped the hold: v1 is stale there and refused.
        run = orderCtx(keys, [v1, v2], 1500);
        run.state.settled.add(v2.snapshot_id + '|policy');
        res = await BS.applyPolicySnapshot(v1, run.ctx);
        assert.strictEqual(res.applied, false, 'an older seq must never apply over a newer one');
        assert.strictEqual(res.terminal, true);
        assert.deepStrictEqual(run.state.injected, []);
    });

    it('armed: applies v1 then v2 once v1 is due, and v2 over a missing v1 past the bound', async function(){
        arm(true);
        let run = orderCtx(keys, [v1, v2], 1500);
        assert.strictEqual((await BS.applyPolicySnapshot(v1, run.ctx)).applied, true);
        const r2 = await BS.applyPolicySnapshot(v2, run.ctx);
        assert.strictEqual(r2.applied, true, r2.reason || '');

        run = orderCtx(keys, [v2], 1300 + GAP_BOUND_S);
        const late = await BS.applyPolicySnapshot(v2, run.ctx);
        assert.strictEqual(late.applied, true, late.reason || '');
    });

    it('unarmed: v2 applies over a v1 that is not mirrored, and v1 then applies, as before', async function(){
        arm(false);
        let run = orderCtx(keys, [v2], 1400);
        assert.strictEqual((await BS.applyPolicySnapshot(v2, run.ctx)).applied, true);
        run = orderCtx(keys, [v1, v2], 1500);
        run.state.settled.add(v2.snapshot_id + '|policy');
        assert.strictEqual((await BS.applyPolicySnapshot(v1, run.ctx)).applied, true);
    });

    it('reads the applied seq and the refused seqs from the local records', async function(){
        const run = orderCtx(keys, [v1, v2], 1500);
        run.state.settled.add(v1.snapshot_id + '|refused');
        run.state.settled.add(v2.snapshot_id + '|policy');
        const st = await run.ctx.indexerDb.getPolicySeqState(NETWORK, ORIGIN, NAME);
        assert.deepStrictEqual(st, { appliedSeq: 2, refusedSeqs: [1] });
    });
});

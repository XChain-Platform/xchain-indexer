'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const H = require('../helpers/apply_harness.js');
const { planListShareInputs } = require('../../../../src/consensus/list_share_settle/inputs.js');
const { planListShareLegs } = require('../../../../src/consensus/list_share_settle/legs.js');
const { injectListShareLegs } = require('../../../../src/consensus/list_share_settle/inject.js');
const { verifyMirrorMembers } = require('../../../../src/consensus/list_share_settle/reread.js');
const { recordSettlement } = require('../../../../src/consensus/bridge_settle/settlements.js');

const row = (o) => H.makeListSnapshotRow(o);
const v1 = () => row({ seq: 1, added: ['nA', 'nB'], admit: { btc: 800 } });
const v2 = () => row({ seq: 2, added: ['nC'], removed: ['nA'], members: ['nB', 'nC'], admit: { btc: 850 } });
const ltc = () => row({ seq: 1, homeChain: 'LTC', homeListIndex: 9, added: ['nL'], admit: { btc: 800 } });
const own = () => row({ seq: 1, homeChain: 'BTC', homeListIndex: 4, added: ['nX'], admit: { btc: 800 } });
const pend = () => row({ seq: 3, added: ['nD'], members: ['nB', 'nC', 'nD'], admit: { btc: 800 }, status: 'pending' });
const inject = (ctx, r, legs) => injectListShareLegs(ctx, {
    legs, snapshotId: r.snapshot_id, owner: H.BRIDGE_DOGE_ON_BTC, homeChain: 'DOGE', homeListIndex: 2701 });
const verify = (ctx, index, r) => verifyMirrorMembers(ctx.indexerDb, {
    mirrorIndex: index, blockIndex: 900, membersHash: r.members_hash, snapshotId: r.snapshot_id });

describe('list share apply harness', () => {
    it('groups finalized foreign heads only', async () => {
        const { ctx } = H.makeListShareCtx({ mirrorRows: [v1(), v2(), ltc(), own(), pend()] });
        const heads = await ctx.indexerDb.mirrorDb().getListSnapshotHeads('regtest', 'BTC');
        assert.deepStrictEqual(
            heads.map((h) => [h.home_chain, Number(h.home_list_index), Number(h.max_seq)]).sort(),
            [['DOGE', 2701, 2], ['LTC', 9, 1]]);
    });

    it('feeds the real planner DOGE 1 and 2 then LTC 1', async () => {
        const { ctx } = H.makeListShareCtx({ mirrorRows: [v1(), v2(), ltc(), own(), pend()] });
        const plan = await planListShareInputs(ctx.indexerDb,
            { network: 'regtest', coin: 'BTC', blockIndex: 900, cap: 10 });
        assert.deepStrictEqual(plan.due.map((r) => [r.home_chain, Number(r.seq)]),
            [['DOGE', 1], ['DOGE', 2], ['LTC', 1]]);
    });

    it('injects a version 1 then a delta and re-reads real membership', async () => {
        const a = v1(), b = v2();
        const { ctx, state } = H.makeListShareCtx({ mirrorRows: [a, b] });
        const r = await inject(ctx, a, planListShareLegs(
            { seq: 1, listType: 2, added: ['nA', 'nB'], removed: [], mirrorIndex: null }));
        const m = await ctx.indexerDb.getListShareMirror('DOGE', 2701);
        assert.strictEqual(Number(m.action_index), r.mirrorIndex);
        assert.strictEqual(state.lists.get(r.mirrorIndex).owner, H.BRIDGE_DOGE_ON_BTC);
        assert.strictEqual(state.lists.get(r.mirrorIndex).type, 2);
        await verify(ctx, r.mirrorIndex, a);
        await inject(ctx, b, planListShareLegs(
            { seq: 2, listType: 2, added: ['nC'], removed: ['nA'], mirrorIndex: r.mirrorIndex }));
        assert.deepStrictEqual(await ctx.indexerDb.getList(r.mirrorIndex, 900), ['nB', 'nC']);
        await verify(ctx, r.mirrorIndex, b);
        assert.strictEqual(state.injected.length, 3);
        assert.ok(state.injected.every((i) => i.isGenesis === true));
        assert.deepStrictEqual(await ctx.indexerDb.getList(424242, 900), []);
    });

    it('counts a repeated settlement once', async () => {
        const { ctx } = H.makeListShareCtx({});
        const a = v1();
        const leg = { src_chain: 'DOGE', src_action_index: 2701, dest_chain: 'BTC', dest_address: null, tick: null };
        await recordSettlement(ctx.indexerDb, 7000, a.snapshot_id, 'list', 900, leg);
        await recordSettlement(ctx.indexerDb, 7000, a.snapshot_id, 'list', 900, leg);
        const counts = await ctx.indexerDb.getAppliedListShareCounts();
        assert.deepStrictEqual(counts.map((c) => [c.src_chain, Number(c.src_action_index), Number(c.applied_seq)]),
            [['DOGE', 2701, 1]]);
    });

    it('changes nothing when legStatus is set', async () => {
        const { ctx, state } = H.makeListShareCtx({ legStatus: 'invalid: X' });
        const ans = await ctx.actions.processTransaction(
            { data: ['LIST', '0', '2', '', 'nZ'].join('|'), source: 's' }, true);
        assert.strictEqual(ans.STATUS, 'invalid: X');
        assert.strictEqual(state.lists.size, 0);
    });

    it('answers an unknown edit index as invalid', async () => {
        const { ctx } = H.makeListShareCtx({});
        const ans = await ctx.actions.processTransaction(
            { data: ['LIST', '1', '1', '99', '', 'nZ'].join('|'), source: 's' }, true);
        assert.strictEqual(ans.STATUS, 'invalid: LIST_ACTION_INDEX (unknown)');
    });

    it('shares no state between two contexts', async () => {
        const first = H.makeListShareCtx({ mirrorRows: [v1()] });
        await first.ctx.actions.processTransaction(
            { data: ['LIST', '0', '2', '', 'nZ'].join('|'), source: 's' }, true);
        const other = H.makeListShareCtx({});
        assert.strictEqual(other.state.lists.size, 0);
        assert.strictEqual(other.state.injected.length, 0);
        assert.strictEqual(other.state.mirrorRows.length, 0);
    });

    it('signs rows as sign does over the passed canonical', () => {
        const k = H.makeKey();
        const canon = (x) => 'C' + x.snapshot_id;
        const [s] = H.signListRows([row({ seq: 1, added: ['nA'] })], [k], canon);
        const sigs = JSON.parse(s.validator_signatures);
        assert.strictEqual(sigs.length, 1);
        assert.strictEqual(sigs[0].pubkey, k.pubkey);
        assert.strictEqual(sigs[0].sig, H.sign(k.privateKey, canon(s)));
    });
});

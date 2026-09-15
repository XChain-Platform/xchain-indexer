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
 * Token-policy inheritance: applying a finalized policy_snapshots row to the bridged copy
 * (the apply half of policy inheritance).
 *
 * WHAT THESE TESTS ARE FOR. The injected legs are CONSENSUS-VISIBLE: each is a synthetic
 * transaction whose vout is a pinned ordinal, so the action index every node assigns to every
 * leg is decided here. The cases therefore read back the INJECTED TRANSACTIONS - their wire
 * strings, their tx_hash and their vouts - rather than asserting that the function returned
 * applied:true.
 *
 * THE GUARDS WITH THEIR OWN CASES, each written to go red on the EFFECT:
 *   - the policy_hash recomputation  (a tampered membership array injects nothing, terminally)
 *   - the canonical order check      (an out-of-order array injects nothing and is not re-sorted)
 *   - the idempotency filter on kind (an applied snapshot injects nothing a second time)
 *   - the per-block cap              (the sixth due snapshot is not in the slice)
 *
 * TERMINAL versus CARRIED is asserted explicitly everywhere it is decided, because getting it
 * backwards is silent in production: a terminal verdict on a retryable condition strands a
 * legitimate snapshot forever, and a carried verdict on a forged one re-runs the forgery on
 * every block for the life of the chain.
 *
 ********************************************************************/

'use strict';

const {
    assert, crypto, eq, BS, Utility, XPOLICY_MAX_PER_BLOCK,
    bindSettlementReads, makeKey, sign, snapshotSet,
    NETWORK, SNAPSHOT, ORIGIN, NAME, COPY, BRIDGE_BTC_ON_DOGE,
    ADDR_A, ADDR_B, ADDR_C, makeSnapshot, makeCtx,
} = require('./policy_apply.test/helpers/setup.js');

describe('policy apply: token-policy inheritance onto a bridged copy', function(){
    describe('the membership hash', function(){

        it('is the canonical text, with "-" for an ABSENT list and "0" for an EMPTY one', function(){
            const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
            assert.strictEqual(BS.policyHash(null, null, false), sha('ALLOW|-|BLOCK|-|SLEEP|0'));
            assert.strictEqual(BS.policyHash([], null, false),   sha('ALLOW|0|BLOCK|-|SLEEP|0'));
            assert.strictEqual(BS.policyHash(null, [], true),    sha('ALLOW|-|BLOCK|0|SLEEP|1'));
            assert.strictEqual(BS.policyHash([ADDR_A, ADDR_B], [ADDR_C], false),
                sha('ALLOW|2|' + ADDR_A + '|' + ADDR_B + '|BLOCK|1|' + ADDR_C + '|SLEEP|0'));
        });

        it('is FROZEN: these digests are what the hub signed and cannot move', function(){
            // policy_hash is inside the signed XPOLICY canonical, so its preimage is a
            // byte-match obligation forever. There is a SECOND implementation of it on the read
            // side (api.js bridgePolicyHash, which gettokenpolicy serves to the hub), and no
            // test pins the two to each other; these literals are what keeps this side from
            // drifting silently. A change here that is not matched there refuses every snapshot
            // on every chain at once, which is why it is a frozen-literal case and not a
            // round-trip through the same function.
            assert.strictEqual(BS.policyHash(null, null, false),
                'fbf0a3d750d94d72b3d72b7a439c8480482291706bcfd0a3091b09738720c55a');
            assert.strictEqual(BS.policyHash([], null, false),
                '475306e714794247e7c7e4c3e250a58059cf98d151ca91eae17b4bb54c9d3e6a');
            assert.strictEqual(BS.policyHash(null, null, true),
                '679fb7853b9ee54a3dd488cedda3d91e484255c831dd4464b2a02bf2a3326587');
            assert.strictEqual(BS.policyHash([ADDR_A, ADDR_B], [ADDR_C], false),
                '39a59aa3151ec050002f599ffa4ab2a6a4466c3b508082d83653063a8100e945');
        });

        it('distinguishes an absent list from an empty one, which mean opposite things', function(){
            // An empty ALLOW_LIST is deny-everyone under isActionAllowed; an absent one is no
            // gate at all. A hash that collapsed them would let the mirror swap one for the
            // other without changing a signature.
            assert.notStrictEqual(BS.policyHash(null, null, false), BS.policyHash([], null, false));
        });

        it('commits the sleep bit, which the wire canonical deliberately does not carry', function(){
            assert.notStrictEqual(BS.policyHash(null, null, false), BS.policyHash(null, null, true));
            const awake  = BS.policyCanonical(makeSnapshot([], { sleeping: false }));
            const asleep = BS.policyCanonical(makeSnapshot([], { sleeping: true }));
            // The two canonicals differ ONLY through policy_hash: `sleeping` is not a field of
            // the canonical, so the two strings differ in exactly one position, the hash.
            assert.notStrictEqual(awake, asleep);
            const fa = awake.split('|'), fb = asleep.split('|');
            assert.strictEqual(fa.length, fb.length);
            const differing = fa.map((v, i) => v === fb[i] ? null : i).filter(i => i !== null);
            assert.strictEqual(differing.length, 1, 'sleeping must reach the canonical only through policy_hash');
        });
    });
});
describe('policy apply: token-policy inheritance onto a bridged copy', function(){
    describe('the signed canonical', function(){

        it('is the spec field order, wrapped by the EQUIV header under the POLICY tag', function(){
            const row = makeSnapshot([], {});
            const raw = ['XPOLICY', row.snapshot_id, '1200', 'BTC', NAME, '1', '500',
                         row.policy_hash, '1000', 'regtest'].join('|');
            assert.strictEqual(BS.policyCanonical(row),
                eq.buildEquivCanonical(eq.ENGINE_TAGS.POLICY, row.snapshot_id, 0, raw));
        });
    });

    describe('the canonical order check', function(){

        it('accepts a byte-ordered array and refuses a reordered one', function(){
            assert.strictEqual(BS.verifyMembershipOrder([ADDR_A, ADDR_B, ADDR_C]), true);
            assert.strictEqual(BS.verifyMembershipOrder([ADDR_B, ADDR_A]), false);
            assert.strictEqual(BS.verifyMembershipOrder(null), true);
            assert.strictEqual(BS.verifyMembershipOrder([ADDR_A]), true);
        });

        // GUARD: order is VERIFIED, never repaired.
        it('injects NOTHING for an out-of-order array, and does not re-sort it', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            // Signed and hashed over the REVERSED array, so the hash matches and only the
            // order is wrong: without the order guard this row would apply.
            const row  = makeSnapshot(keys, { allow: [ADDR_B, ADDR_A] });
            assert.strictEqual(row.policy_hash, BS.policyHash([ADDR_B, ADDR_A], null, false));
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.POLICY_ORDER);
            assert.strictEqual(res.terminal, true, 'an order failure is a property of the row');
            assert.deepStrictEqual(state.injected, []);
            assert.deepStrictEqual(state.settlements, []);
        });
    });
});

describe('policy apply: token-policy inheritance onto a bridged copy', function(){
    describe('terminal versus carried', function(){
        // GUARD: the policy_hash recomputation.
        it('is TERMINAL and injects nothing when the membership does not match policy_hash', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { allow: [ADDR_A] });
            // Swap a member without touching the hash or the signatures: exactly what a
            // tampering mirror can do, since the arrays are transport and are not signed.
            row.allow_list = JSON.stringify([ADDR_C]);
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.POLICY_HASH);
            assert.strictEqual(res.terminal, true);
            assert.deepStrictEqual(state.injected, []);
        });

        it('is TERMINAL for a malformed membership transport, never read as an empty list', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { allow: [ADDR_A] });
            row.allow_list = 'not json at all';
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.terminal, true);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.POLICY_HASH);
            assert.deepStrictEqual(state.injected, []);
        });

        it('is TERMINAL for a quorum that does not meet the bar', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot([keys[0]], {});
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.QUORUM);
            assert.strictEqual(res.terminal, true);
            assert.deepStrictEqual(state.injected, []);
        });

        it('is TERMINAL for a foreign network and for a foreign btc_chain_id', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const foreignNet = await BS.applyPolicySnapshot(
                makeSnapshot(keys, { row: { network: 'mainnet' } }), makeCtx({ validators: snapshotSet(keys) }).ctx);
            assert.strictEqual(foreignNet.terminal, true);
            assert.strictEqual(foreignNet.reason, BS.SETTLE_REASON.NETWORK);

            const c = makeCtx({ validators: snapshotSet(keys) });
            c.ctx.config['BTC_CHAIN_ID'] = 'c'.repeat(64);
            const foreignChain = await BS.applyPolicySnapshot(
                makeSnapshot(keys, { row: { btc_chain_id: 'b'.repeat(64) } }), c.ctx);
            assert.strictEqual(foreignChain.terminal, true);
            assert.strictEqual(foreignChain.reason, BS.SETTLE_REASON.CHAIN_ID);
        });
    });
});

describe('policy apply: token-policy inheritance onto a bridged copy', function(){
    describe('terminal versus carried', function(){
        it('CARRIES a snapshot whose effective_time has not been reached', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { row: { effective_time: 999999 } });
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.terminal, false, 'a later block reaches the time');
            assert.deepStrictEqual(state.injected, []);
        });

        it('CARRIES a snapshot for a tick this chain holds no copy of', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, {});
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys), tokens: {} });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.POLICY_NO_COPY);
            assert.strictEqual(res.terminal, false, 'a later in-leg can create the copy');
            assert.deepStrictEqual(state.injected, []);
        });

        // GUARD: apply order by policy_seq, ACROSS blocks.
        it('CARRIES a snapshot while an earlier finalized seq for the tick is unapplied', async function(){
            const keys  = [makeKey(), makeKey(), makeKey()];
            const seq1  = { snapshot_id: 'f'.repeat(64), origin_chain: ORIGIN, tick: NAME,
                            policy_seq: 1, network: NETWORK, status: 'finalized', effective_time: 9999 };
            const seq2  = makeSnapshot(keys, { allow: [ADDR_A], row: { policy_seq: 2 } });
            // effective_time is NOT monotonic across seq, so seq 2 comes due first here. Without
            // the guard the copy would end up enforcing seq 1's membership after seq 2's.
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys), mirrorPolicies: [seq1] });
            const res = await BS.applyPolicySnapshot(seq2, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.POLICY_SEQ_GAP);
            assert.strictEqual(res.terminal, false, 'a later block can apply seq 1 first');
            assert.deepStrictEqual(state.injected, []);

            // Once seq 1 is recorded, seq 2 applies.
            const after = makeCtx({ validators: snapshotSet(keys), mirrorPolicies: [seq1],
                                    settled: [seq1.snapshot_id + '|policy'] });
            const ok = await BS.applyPolicySnapshot(seq2, after.ctx);
            assert.strictEqual(ok.applied, true, ok.reason || '');
            assert.ok(after.state.injected.length > 0);
        });

        it('CARRIES a snapshot whose capability roster is not mirrored yet', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, {});
            const { ctx, state } = makeCtx({ validators: [] });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.SNAPSHOT_ABSENT);
            assert.strictEqual(res.terminal, false);
            assert.deepStrictEqual(state.injected, []);
        });
    });
});

describe('policy apply: token-policy inheritance onto a bridged copy', function(){
    describe('the injected legs', function(){
        it('creates both lists, points the row at them, at the PINNED ordinals', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { allow: [ADDR_A, ADDR_B], block: [ADDR_C] });
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');

            assert.strictEqual(state.injected.length, 3, 'allow create, block create, ISSUE 5');
            const vouts = state.injected.map(t => t.vout);
            assert.deepStrictEqual(vouts, [BS.POLICY_LEG_ORDINAL.ALLOW_CREATE_OR_REMOVE,
                                           BS.POLICY_LEG_ORDINAL.BLOCK_CREATE_OR_REMOVE,
                                           BS.POLICY_LEG_ORDINAL.ISSUE_POINT]);
            // A type-2 (address) LIST create carrying the full membership, in order.
            assert.strictEqual(state.injected[0].data, 'LIST|0|2||' + ADDR_A + '|' + ADDR_B);
            assert.strictEqual(state.injected[1].data, 'LIST|0|2||' + ADDR_C);
            assert.ok(/^ISSUE\|5\|BTC\.PEPECASH\|\d+\|\d+$/.test(state.injected[2].data), state.injected[2].data);
            // One synthetic transaction identity per snapshot, so the legs share a hash and are
            // told apart by the vout: that is what makes the action indexes node-invariant.
            state.injected.forEach(t => assert.strictEqual(t.tx_hash, BS.POLICY_TX_PREFIX + row.snapshot_id.slice(0, 48)));
            assert.ok(state.injected[0].tx_hash.length <= 64);
            // Every leg is sourced from the copy's owner, the keyless bridge role address.
            state.injected.forEach(t => assert.strictEqual(t.source, BRIDGE_BTC_ON_DOGE));
        });

        it('injects NO list leg at all when the origin holds no list (absent stays absent)', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, {});     // both lists null, not sleeping
            const { ctx, state } = makeCtx({ validators: snapshotSet(keys) });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.deepStrictEqual(state.injected, [],
                'materializing an absent list as an EMPTY one would be deny-everyone');
            // Still recorded, or the snapshot would be re-evaluated on every later block forever.
            assert.strictEqual(state.settlements.length, 1);
            assert.strictEqual(state.settlements[0].kind, 'policy');
        });

        it('edits an existing list: REMOVE at its ordinal, ADD at its own, as TWO actions', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeSnapshot(keys, { allow: [ADDR_A, ADDR_C] });
            const { ctx, state } = makeCtx({
                validators: snapshotSet(keys),
                tokens: { [COPY]: { TICK_ID: 11, DECIMALS: 2, ALLOW_LIST: 4242, BLOCK_LIST: null } },
                lists:  { '4242': [ADDR_A, ADDR_B] }        // B leaves, C joins
            });
            const res = await BS.applyPolicySnapshot(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.strictEqual(state.injected.length, 2, 'a LIST format 1 carries ONE edit verb');
            assert.strictEqual(state.injected[0].data, 'LIST|1|2|4242||' + ADDR_B);   // REMOVE
            assert.strictEqual(state.injected[0].vout, BS.POLICY_LEG_ORDINAL.ALLOW_CREATE_OR_REMOVE);
            assert.strictEqual(state.injected[1].data, 'LIST|1|1|4242||' + ADDR_C);   // ADD
            assert.strictEqual(state.injected[1].vout, BS.POLICY_LEG_ORDINAL.ALLOW_ADD);
            // No ISSUE 5: an edit writes under its own index and never moves the pointer.
            assert.ok(!state.injected.some(t => /^ISSUE\|/.test(t.data)));
        });
    });
});

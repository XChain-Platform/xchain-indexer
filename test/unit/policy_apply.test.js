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
 * (the token bridge policy spec sections 4 to 6).
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

const assert  = require('assert');
const crypto  = require('crypto');
const eq      = require('../../src/equivocation_header.js');
const BS      = require('../../src/bridge_settle.js');
const Utility = require('../../src/utility.js');
const { XPOLICY_MAX_PER_BLOCK } = require('../../src/protocol/constants.js');

function makeKey(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { pubkey: spki.subarray(spki.length - 32).toString('hex'), privateKey };
}
function sign(privateKey, msg){
    return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex');
}
function snapshotSet(keys){
    return keys.map((k, i) => ({ pubkey: k.pubkey, source: 'src' + i, weight: '100' }));
}

const NETWORK  = 'regtest';
const SNAPSHOT = 1200;
const ORIGIN   = 'BTC';
const NAME     = 'PEPECASH';
const COPY     = ORIGIN + '.' + NAME;
const BRIDGE_BTC_ON_DOGE = 'nDOGEEscrowForBtcXXXXXXXXXXXXXXXXX';
// Canonical (byte) order, so the fixture is already what the hub hashed.
const ADDR_A = 'nAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = 'nBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR_C = 'nCcccccccccccccccccccccccccccccccc';

// A policy snapshot row. `policy_hash` is computed by the MODULE'S OWN hasher from the same
// arrays the row carries, which is what makes the tampering cases below real: change the
// array without re-signing and the recomputation no longer matches.
function makeSnapshot(signers, overrides){
    const o = overrides || {};
    const allow = (o.allow !== undefined) ? o.allow : null;
    const block = (o.block !== undefined) ? o.block : null;
    const sleeping = !!o.sleeping;
    const row = Object.assign({
        snapshot_id:     'd'.repeat(64),
        snapshot_block:  SNAPSHOT,
        origin_chain:    ORIGIN,
        tick:            NAME,
        policy_seq:      1,
        origin_block:    500,
        policy_hash:     BS.policyHash(allow, block, sleeping),
        allow_list:      allow === null ? null : JSON.stringify(allow),
        block_list:      block === null ? null : JSON.stringify(block),
        sleeping:        sleeping ? 1 : 0,
        effective_time:  1000,
        network:         NETWORK,
        finalizing_view: 0,
        status:          'finalized',
        push_generation: 0,
        btc_chain_id:    null
    }, o.row || {});
    row.validator_signatures = JSON.stringify(
        (signers || []).map(s => ({ pubkey: s.pubkey, sig: sign(s.privateKey, BS.policyCanonical(row)) })));
    return row;
}

function makeCtx(opts){
    const o = opts || {};
    const config = {
        COIN: 'DOGE', NETWORK: NETWORK, GAS: 'XCHAIN',
        ADDRESS: { GAS: 'nGasOwnerXXXXXXXXXXXXXXXXXXXXXXXXX', BRIDGE_BTC: BRIDGE_BTC_ON_DOGE },
        BTC_CHAIN_ID: null
    };
    const state = { injected: [], settlements: [], actions: [], settled: new Set(o.settled || []),
                    mirrorPolicies: o.mirrorPolicies || [] };
    let nextAction = 7000;
    const tokens = o.tokens || { [COPY]: { TICK_ID: 11, DECIMALS: 2, ALLOW_LIST: null, BLOCK_LIST: null } };

    const db = {
        config: config,
        _mirrorDb: () => ({ doQuery: async (sql, args) => {
            if(!/policy_snapshots/.test(sql)) return [];
            // The earlier-seq probe is a narrow query; the fake applies its predicate so the
            // gap case exercises the real filter rather than the whole mirror.
            if(/policy_seq < \?/.test(sql))
                return state.mirrorPolicies.filter(r => String(r.origin_chain) === String(args[1]) &&
                                                        String(r.tick) === String(args[2]) &&
                                                        Number(r.policy_seq) < Number(args[3]))
                                           .sort((a, b) => Number(a.policy_seq) - Number(b.policy_seq));
            return state.mirrorPolicies.slice();
        }}),
        doQuery: async (sql, args) => {
            if(/FROM bridge_settlements/.test(sql) && /LIMIT 1/.test(sql))
                return state.settled.has(String(args[0]) + '|' + String(args[1])) ? [{ transfer_id: args[0] }] : [];
            if(/FROM bridge_settlements/.test(sql)){
                const kind = /kind = 'policy'/.test(sql) ? 'policy' : 'transfer';
                return (args || []).filter(id => state.settled.has(String(id) + '|' + kind)).map(id => ({ transfer_id: id }));
            }
            if(/INSERT IGNORE INTO bridge_settlements/.test(sql)){
                state.settlements.push({ action_index: args[0], transfer_id: args[1], kind: args[2] });
                state.settled.add(String(args[1]) + '|' + String(args[2]));
            }
            return [];
        },
        getValidatorsByCapability:   async () => (o.validators || []),
        getStakeWeightsByCapability: async () => (o.validators || []),
        getTickerId:    async (tick) => (tokens[tick] ? tokens[tick]['TICK_ID'] : null),
        getTokenInfo:   async (tick) => tokens[tick] || null,
        getList:        async (idx) => (o.lists || {})[String(idx)] || [],
        isTickSleeping: async () => !!o.currentlySleeping,
        createActionIndex: async (d) => { state.actions.push(d); return nextAction++; },
        updateBalances: async () => {},
        updateTokens:   async () => {}
    };
    const ctx = {
        actions: {
            processTransaction: async (tx) => {
                state.injected.push(tx);
                return { ACTION_INDEX: nextAction++, STATUS: (o.legStatus || 'valid') };
            },
            mapper: { createMappings: async () => {} }
        },
        indexerDb: db, util: new Utility(config), mapper: { createMappings: async () => {} },
        config: config, coin: 'DOGE', network: NETWORK, blockIndex: 900, blockTime: 2000
    };
    return { ctx, state };
}

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
            // the canonical (D17), so the two strings differ in exactly one position, the hash.
            assert.notStrictEqual(awake, asleep);
            const fa = awake.split('|'), fb = asleep.split('|');
            assert.strictEqual(fa.length, fb.length);
            const differing = fa.map((v, i) => v === fb[i] ? null : i).filter(i => i !== null);
            assert.strictEqual(differing.length, 1, 'sleeping must reach the canonical only through policy_hash');
        });
    });

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

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
 * The XBRIDGE settle pass: applying this chain's leg of a finalized transfer
 * (the base bridge spec sections 6 to 9, work rows 6 and 17).
 *
 * WHAT THESE TESTS ARE FOR. Every quorum case is built from REAL Ed25519 keys and REAL
 * signatures over the module's OWN canonical, so a passing quorum means the same arithmetic
 * a hub does, not that a fixture agreed with itself. The ledger cases assert the CREDITS AND
 * DEBITS the apply produced, not that it returned a truthy object: "applied" is a claim about
 * the ledger, so the ledger is what is read back.
 *
 * THE FOUR GUARDS EACH HAVE THEIR OWN CASE, and each is written so that deleting the guard
 * turns the case red on the EFFECT rather than on a message:
 *   - the idempotency filter        (an already-settled id moves no units)
 *   - the escrow would-go-negative  (an out leg short of escrow moves no units)
 *   - the D2 cross-check ok:false   (a refused proof moves no units and mints no action)
 *   - the per-block cap             (the 26th due transfer is not in the slice)
 * A fifth property has a case of its own because it is the one thing that must NOT be a
 * refusal: a checkpoint this node does not hold yet STALLS the pass.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const eq     = require('../../src/equivocation_header.js');
const swq    = require('../../src/stake_weighted_quorum.js');
const CHK    = require('../../src/bridge_checkpoint_check.js');
const BS     = require('../../src/bridge_settle.js');
const PC     = require('../../src/bridge_proof_client.js');
const M      = require('../../src/merkle.js');
const SUB    = require('../../src/state_subtree_activation.js');
const Utility = require('../../src/utility.js');
const { XBRIDGE_MAX_PER_BLOCK } = require('../../src/protocol/constants.js');

// Ed25519 keypair whose raw 32-byte pubkey / 64-byte sig hex match src/ed25519.js verify().
function makeKey(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { pubkey: spki.subarray(spki.length - 32).toString('hex'), privateKey };
}
function sign(privateKey, msg){
    return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex');
}

const NETWORK  = 'regtest';
const SNAPSHOT = 1200;
const DEST_ADDR = 'nDestinationAddressXXXXXXXXXXXXXXX';
const ESCROW_DOGE_ON_BTC = 'mBTCEscrowForDogeXXXXXXXXXXXXXXXXX';
const ESCROW_BTC_ON_DOGE = 'nDOGEEscrowForBtcXXXXXXXXXXXXXXXXX';

// The REAL escrow address the cross-check resolves for BTC -> DOGE on this network, read
// through the same door the check reads it (the origin chain's own coin config). A fixture
// address here would make every in-leg proof fail PROOF_BINDING and hide whatever the ledger
// assertions below were really proving.
const REAL_ESCROW = CHK.resolveEscrowAddress('BTC', 'DOGE', NETWORK);
const OTHER_HOLDER = 'mSomeOtherHolderXXXXXXXXXXXXXXXXXX';
const CP_HEIGHT    = 1205;      // the first checkpoint at or after SNAPSHOT

// A full, VALID escrow proof envelope for `balance` of `tick`, built from the real sparse
// Merkle tree and the real state-root assembly, the way L17's own suite builds one: the root
// is a real root and the inclusion proof comes out of merkle.js, so "the cross-check passed"
// means the same arithmetic a producing node does.
function buildProof(balance, tick){
    const t   = tick || 'XCHAIN';
    const smt = new M.SparseMerkleTree();
    smt.set(M.balanceKey('BTC', NETWORK, REAL_ESCROW, t), M.amountLeaf(balance));
    smt.set(M.balanceKey('BTC', NETWORK, OTHER_HOLDER, t), M.amountLeaf('41.5'));
    const subRoots = { balances_root: smt.rootHex(), stakes_root: M.toHex(M.EMPTY_SMT_ROOT) };
    return {
        chain: 'BTC', network: NETWORK, block_index: CP_HEIGHT,
        sub_roots: subRoots,
        address: REAL_ESCROW, tick: t, balance: balance,
        balance_proof: { siblings: smt.prove(M.balanceKey('BTC', NETWORK, REAL_ESCROW, t)).siblings },
        checkpoint: {
            chain: 'BTC', network: NETWORK, block_index: CP_HEIGHT, checkpoint_seq: 77,
            snapshot_block: CP_HEIGHT,
            state_root: M.toHex(M.stateRoot(subRoots)),
            state_root_version: SUB.stateRootVersion(CP_HEIGHT, NETWORK, 'BTC')
        }
    };
}

// A transfer row as the hub signs and the mirror delivers it. `signers` sign the module's own
// canonical, so a correctly built row verifies and a tampered one does not.
function makeTransfer(signers, overrides){
    const row = Object.assign({
        transfer_id:    'a'.repeat(64),
        snapshot_block: SNAPSHOT,
        network:        NETWORK,
        src_chain:      'BTC',
        src_action_index: 4242,
        src_address:    'mSourceAddressXXXXXXXXXXXXXXXXXXXX',
        dest_chain:     'DOGE',
        dest_address:   DEST_ADDR,
        tick:           'XCHAIN',
        decimals:       8,
        amount:         '10.00000000',
        effective_time: 1000,
        finalizing_view: 0,
        status:         'finalized',
        push_generation: 0,
        btc_chain_id:   null
    }, overrides || {});
    row.validator_signatures = JSON.stringify(
        (signers || []).map(s => ({ pubkey: s.pubkey, sig: sign(s.privateKey, BS.transferCanonical(row)) })));
    return row;
}

// Three validators, three distinct staking sources, equal weight: a 3-of-3 signature set is
// over two thirds and a 1-of-3 is not, under both the weighted and the 2f+1 rule.
function snapshotSet(keys){
    return keys.map((k, i) => ({ pubkey: k.pubkey, source: 'src' + i, weight: '100' }));
}

// A settle-pass ctx over an in-memory ledger. Every method the apply reaches is here; nothing
// is stubbed that the apply would otherwise have computed itself.
function makeCtx(opts){
    const o = opts || {};
    const config = {
        COIN:    o.coin || 'DOGE',
        NETWORK: NETWORK,
        GAS:     'XCHAIN',
        ADDRESS: { GAS: 'nGasOwnerXXXXXXXXXXXXXXXXXXXXXXXXX',
                   BRIDGE_BTC:  ESCROW_BTC_ON_DOGE,
                   BRIDGE_DOGE: ESCROW_DOGE_ON_BTC },
        BTC_CHAIN_ID: o.chainId || null
    };
    const state = {
        credits: [], debits: [], settlements: [], actions: [], mappings: [],
        balances: o.balances || {},          // tick_id -> amount, for the escrow address
        settled:  new Set(o.settled || []),
        mirrorTransfers: o.mirrorTransfers || [],
        mirrorPolicies:  o.mirrorPolicies  || [],
        injected: []
    };
    let nextAction = 5000;

    const mirror = {
        doQuery: async (sql, args) => {
            if(/FROM bridge_transfers/.test(sql)){
                const rows = state.mirrorTransfers.slice();
                // A real database applies the query's own ORDER BY. The fake honours it only
                // when the SQL actually asks for it, so the ordering case below proves the
                // QUERY carries the consensus order rather than proving the fixture was
                // already sorted.
                if(/ORDER BY snapshot_block ASC, transfer_id ASC/.test(sql))
                    rows.sort((a, b) => (Number(a.snapshot_block) - Number(b.snapshot_block)) ||
                                        (String(a.transfer_id) < String(b.transfer_id) ? -1 : 1));
                return rows;
            }
            if(/FROM policy_snapshots/.test(sql)) return state.mirrorPolicies.slice();
            return [];
        }
    };
    const db = {
        config: config,
        _mirrorDb: () => mirror,
        doQuery: async (sql, args) => {
            if(/FROM bridge_settlements/.test(sql) && /LIMIT 1/.test(sql))
                return state.settled.has(String(args[0]) + '|' + String(args[1])) ? [{ transfer_id: args[0] }] : [];
            if(/FROM bridge_settlements/.test(sql)){
                const kind = /kind = 'policy'/.test(sql) ? 'policy' : 'transfer';
                return (args || []).filter(id => state.settled.has(String(id) + '|' + kind))
                                   .map(id => ({ transfer_id: id }));
            }
            if(/INSERT IGNORE INTO bridge_settlements/.test(sql)){
                state.settlements.push({ action_index: args[0], transfer_id: args[1], kind: args[2], block_index: args[3] });
                state.settled.add(String(args[1]) + '|' + String(args[2]));
                return [];
            }
            return [];
        },
        getValidatorsByCapability: async () => (o.validators || []),
        getStakeWeightsByCapability: async () => (o.validators || []),
        createActionIndex: async (data) => { state.actions.push(data); return nextAction++; },
        getTokenInfo: async (tick) => (o.tokens || {})[tick] || null,
        getTickerId: async (tick) => ((o.tokens || {})[tick] ? (o.tokens || {})[tick]['TICK_ID'] : null),
        getAddressBalances: async () => Object.assign({}, state.balances),
        createDebit:  async (ai, tick, amount, address) => { state.debits.push([tick, amount, address]); },
        createCredit: async (ai, tick, amount, address) => { state.credits.push([tick, amount, address]); },
        createEscrow: async () => {},
        updateBalances: async () => {},
        updateTokens:   async () => {},
        getList:        async () => [],
        isTickSleeping: async () => false
    };
    const util = new Utility(config);
    const ctx = {
        actions:   { processTransaction: async (tx) => { state.injected.push(tx); return { ACTION_INDEX: nextAction++, STATUS: 'valid' }; },
                     mapper: { createMappings: async (d) => { state.mappings.push(d); } } },
        indexerDb: db,
        util:      util,
        mapper:    { createMappings: async (d) => { state.mappings.push(d); } },
        config:    config,
        coin:      config.COIN,
        network:   NETWORK,
        blockIndex: 900,
        blockTime:  2000
    };
    return { ctx, state, config };
}

describe('bridge_settle: the XBRIDGE settle pass', function(){

    describe('the signed canonical', function(){

        it('is the spec field order, byte for byte, wrapped by the EQUIV header', function(){
            const row = makeTransfer([], {});
            const raw = ['XBRIDGE', row.transfer_id, '1200', 'XCHAIN', '8',
                         'BTC', '4242', row.src_address, 'DOGE', DEST_ADDR,
                         '10.00000000', '1000', 'regtest'].join('|');
            // regtest arms the EQUIV header at 0, so the wrap is unconditional on this venue;
            // asserting the wrapped form AND the inner content pins both halves.
            const expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.BRIDGE, row.transfer_id, 0, raw);
            assert.strictEqual(BS.transferCanonical(row), expected);
            assert.ok(BS.transferCanonical(row).endsWith(raw));
        });

        it('changes when any signed field changes, so a tampered row cannot reuse a signature', function(){
            const a = BS.transferCanonical(makeTransfer([], {}));
            const b = BS.transferCanonical(makeTransfer([], { amount: '10.00000001' }));
            const c = BS.transferCanonical(makeTransfer([], { dest_address: 'nAttacker' }));
            assert.notStrictEqual(a, b);
            assert.notStrictEqual(a, c);
        });
    });

    describe('quorum verification (the CROSS_SETTLE rule)', function(){

        it('accepts a fully signed set and reports the count', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx } = makeCtx({ validators: snapshotSet(keys) });
            const q = await BS.verifyQuorum(BS.transferCanonical(row), row.validator_signatures,
                                            SNAPSHOT, NETWORK, ctx.indexerDb);
            assert.strictEqual(q.met, true);
            assert.strictEqual(q.valid, 3);
            assert.strictEqual(q.snapshotAbsent, false);
        });

        it('refuses a forged signature over a different message', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const sigs = JSON.parse(row.validator_signatures);
            sigs.forEach(s => { s.sig = sign(keys[0].privateKey, 'a different message entirely'); });
            const { ctx } = makeCtx({ validators: snapshotSet(keys) });
            const q = await BS.verifyQuorum(BS.transferCanonical(row), JSON.stringify(sigs),
                                            SNAPSHOT, NETWORK, ctx.indexerDb);
            assert.strictEqual(q.met, false);
            assert.strictEqual(q.valid, 0);
        });

        it('counts a validator whose garbage entry precedes its real one (seen-set after verify)', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const good = JSON.parse(row.validator_signatures);
            // The garbage-then-valid pair for ONE qualified validator. Marking `seen` on first
            // encounter would suppress the real signature and fail a quorate row CLOSED.
            const sigs = [{ pubkey: keys[0].pubkey, sig: 'ff'.repeat(64) }].concat(good);
            const { ctx } = makeCtx({ validators: snapshotSet(keys) });
            const q = await BS.verifyQuorum(BS.transferCanonical(row), JSON.stringify(sigs),
                                            SNAPSHOT, NETWORK, ctx.indexerDb);
            assert.strictEqual(q.valid, 3);
            assert.strictEqual(q.met, true);
        });

        it('reports an absent capability snapshot as a RETRY, never as a refusal', async function(){
            const keys = [makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx } = makeCtx({ validators: [] });
            const q = await BS.verifyQuorum(BS.transferCanonical(row), row.validator_signatures,
                                            SNAPSHOT, NETWORK, ctx.indexerDb);
            assert.strictEqual(q.snapshotAbsent, true);
            assert.strictEqual(q.met, false);
        });
    });

    describe('the IN leg (this chain mints)', function(){

        it('credits the destination at the signed decimals and records the settlement', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
            });
            // A real proof of a real escrow balance above the transfer amount. The pass calls
            // the cross-check unconditionally, so without one this case would prove nothing.
            ctx.proof = buildProof('100.00000000');
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
            assert.deepStrictEqual(state.debits, []);
            assert.strictEqual(state.settlements.length, 1);
            assert.strictEqual(state.settlements[0].kind, 'transfer');
            assert.strictEqual(state.settlements[0].transfer_id, row.transfer_id);
            // The gas tick is wire version 2; a general token would be 5.
            assert.strictEqual(state.actions[0].FORMAT, 2);
            assert.strictEqual(state.actions[0].ACTION, 'XBRIDGE');
        });

        it('mints wire version 5 for a general token, under the rooted child tick', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { tick: 'PEPECASH', decimals: 2, amount: '5.00' });
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { 'BTC.PEPECASH': { TICK_ID: 9, DECIMALS: 2, SUPPLY: '0' },
                          'BTC':          { TICK_ID: 8, DECIMALS: 0, SUPPLY: '0', OWNER: ESCROW_BTC_ON_DOGE } }
            });
            ctx.proof = buildProof('9.00', 'PEPECASH');
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.deepStrictEqual(state.credits, [['BTC.PEPECASH', '5.00', DEST_ADDR]]);
            assert.strictEqual(state.actions[0].FORMAT, 5);
        });
    });

    describe('the OUT leg (this chain releases escrow)', function(){

        it('debits the escrow role address and credits the destination', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            // Origin BTC releasing escrow from a DOGE burn: src_chain DOGE, dest_chain BTC.
            const row  = makeTransfer(keys, { src_chain: 'DOGE', dest_chain: 'BTC' });
            const { ctx, state } = makeCtx({
                coin: 'BTC',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '100' } },
                balances: { 7: '50.00000000' }
            });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.deepStrictEqual(state.debits,  [['XCHAIN', '10.00000000', ESCROW_DOGE_ON_BTC]]);
            assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
        });

        // GUARD 1 of 4: an escrow that would go negative is a protocol violation.
        it('applies NOTHING when the escrow would go negative', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { src_chain: 'DOGE', dest_chain: 'BTC' });
            const { ctx, state } = makeCtx({
                coin: 'BTC',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '100' } },
                balances: { 7: '9.99999999' }        // one satoshi short of the transfer
            });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.ESCROW_SHORT);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.debits, []);
            assert.deepStrictEqual(state.settlements, []);
            assert.deepStrictEqual(state.actions, [], 'a refused row must mint no action index');
        });
    });

    describe('the refusal and deferral paths', function(){

        // GUARD 2 of 4: the idempotency filter.
        it('applies NOTHING for an id already recorded in bridge_settlements', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } },
                settled: [row.transfer_id + '|transfer']
            });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.ALREADY_APPLIED);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.actions, []);
        });

        it('keys idempotency on (id, kind), so a policy record does not suppress a transfer', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } },
                settled: [row.transfer_id + '|policy']       // same id, the OTHER kind
            });
            ctx.proof = buildProof('100.00000000');
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.strictEqual(state.credits.length, 1);
        });

        // GUARD 3 of 4: the D2 cross-check.
        it('applies NOTHING when the escrow cross-check returns ok:false', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
            });
            // No ctx.proof at all: the real check refuses an in leg with PROOF_MISSING. This is
            // the check's own verdict reached through the settle pass's one door, not a stub.
            ctx.proof = undefined;
            const cross = BS.verifyEscrowAgainstCheckpoint(row, ctx);
            assert.strictEqual(cross.ok, false);
            assert.strictEqual(cross.reason, CHK.ESCROW_PROOF_REASON.PROOF_MISSING);

            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.ESCROW_PROOF);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.debits, []);
            assert.deepStrictEqual(state.actions, [], 'a refused row must mint no action index');
            assert.deepStrictEqual(state.settlements, []);
        });

        it('carries a row whose effective_time is ahead of this block protocol time', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { effective_time: 999999 });
            const { ctx, state } = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys),
                                             tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8 } } });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.NOT_DUE);
            assert.deepStrictEqual(state.credits, []);
        });

        it('refuses a row signed on another network', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { network: 'mainnet' });
            const { ctx, state } = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys),
                                             tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8 } } });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.NETWORK);
            assert.deepStrictEqual(state.credits, []);
        });

        it('refuses a row carrying a foreign btc_chain_id (a re-genesised rail)', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { btc_chain_id: 'b'.repeat(64) });
            const { ctx, state } = makeCtx({ coin: 'DOGE', chainId: 'c'.repeat(64),
                                             validators: snapshotSet(keys),
                                             tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8 } } });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.CHAIN_ID);
            assert.deepStrictEqual(state.credits, []);
        });

        it('refuses a row whose destination is another chain', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { dest_chain: 'LTC' });
            const { ctx } = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys) });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.NOT_OURS);
        });

        it('refuses a quorum that does not meet the bar, and moves no units', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer([keys[0]], {});           // 1 of 3 sources
            const { ctx, state } = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys),
                                             tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8 } } });
            assert.strictEqual(swq.isStakeWeightedQuorumActive(SNAPSHOT, NETWORK), true);
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.QUORUM);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.actions, []);
        });
    });

    describe('the due set: order and the per-block cap', function(){

        // GUARD 4 of 4: the per-block cap.
        it('orders by (snapshot_block, transfer_id) and slices at XBRIDGE_MAX_PER_BLOCK', async function(){
            // Deliberately built in the WRONG order and with a mixed snapshot_block, so the
            // ordering is proven rather than inherited from the fixture's array order.
            const rows = [];
            for(let i = 0; i < XBRIDGE_MAX_PER_BLOCK + 3; i++)
                rows.push({ transfer_id: String(i).padStart(64, '0'), snapshot_block: (i % 2 ? 2 : 1),
                            dest_chain: 'DOGE', network: NETWORK, effective_time: 1, status: 'finalized' });
            rows.reverse();
            const { ctx } = makeCtx({ coin: 'DOGE', mirrorTransfers: rows });
            const due = await BS.dueBridgeTransfers(ctx);
            assert.strictEqual(due.length, XBRIDGE_MAX_PER_BLOCK,
                'the cap must bound the slice: ' + due.length + ' of a cap of ' + XBRIDGE_MAX_PER_BLOCK);
            // Every even index carries snapshot_block 1 and sorts ahead of every odd one.
            for(let i = 1; i < due.length; i++){
                const prev = due[i - 1], cur = due[i];
                assert.ok(Number(prev.snapshot_block) < Number(cur.snapshot_block) ||
                          (Number(prev.snapshot_block) === Number(cur.snapshot_block) &&
                           String(prev.transfer_id) < String(cur.transfer_id)),
                          'due set is not in (snapshot_block, transfer_id) order at index ' + i);
            }
        });

        it('drops rows already settled and keeps the carried overflow in order', async function(){
            const rows = [];
            for(let i = 0; i < 4; i++)
                rows.push({ transfer_id: String(i).padStart(64, '0'), snapshot_block: 1,
                            dest_chain: 'DOGE', network: NETWORK, effective_time: 1, status: 'finalized' });
            const { ctx } = makeCtx({ coin: 'DOGE', mirrorTransfers: rows,
                                      settled: [String(0).padStart(64, '0') + '|transfer',
                                                String(2).padStart(64, '0') + '|transfer'] });
            const due = await BS.dueBridgeTransfers(ctx);
            assert.deepStrictEqual(due.map(r => r.transfer_id),
                [String(1).padStart(64, '0'), String(3).padStart(64, '0')]);
        });
    });

    describe('the proof transport: a missing checkpoint STALLS, it never refuses', function(){

        it('raises BridgeProofUnavailableError when no checkpoint at or after snapshot_block is held', async function(){
            const row = makeTransfer([], {});          // BTC -> DOGE, so an IN leg needing a proof
            const { ctx } = makeCtx({ coin: 'DOGE' });
            // Both sources answer empty, which is exactly "this node holds none yet".
            ctx.indexerDb.doQuery = async () => [];
            ctx.indexerDb._mirrorDb = () => ({ doQuery: async () => [] });
            await assert.rejects(() => BS.fetchProofForTransfer(row, ctx), (err) => {
                assert.strictEqual(err.name, 'BridgeProofUnavailableError');
                assert.strictEqual(err.stallReason, PC.BRIDGE_PROOF_BARRIER);
                assert.strictEqual(err.detail, PC.PROOF_STALL_REASON.NO_CHECKPOINT);
                return true;
            });
        });

        it('names a barrier-shaped stall reason, so health classifies it as mirror lag', function(){
            // health.js / XChainIndexer.isMirrorBarrierReason keys on the '_barrier' suffix; a
            // reason without it reads as a wedged indexer and pages an operator for mirror lag.
            assert.ok(/_barrier$/.test(PC.BRIDGE_PROOF_BARRIER), PC.BRIDGE_PROOF_BARRIER);
        });

        it('needs no proof for an OUT leg: the escrow it releases is a local balance', async function(){
            const row = makeTransfer([], { src_chain: 'DOGE', dest_chain: 'BTC' });
            const { ctx } = makeCtx({ coin: 'BTC' });
            assert.strictEqual(await BS.fetchProofForTransfer(row, ctx), null);
            // And the check itself says so, rather than this test asserting the exemption twice.
            const cross = CHK.verifyEscrowAgainstCheckpoint(row, ctx);
            assert.strictEqual(cross.ok, true);
            assert.strictEqual(cross.reason, CHK.ESCROW_PROOF_REASON.OUT_LEG);
        });

        it('needs no proof for a row whose destination is another chain', async function(){
            const row = makeTransfer([], { dest_chain: 'LTC' });
            const { ctx } = makeCtx({ coin: 'DOGE' });
            assert.strictEqual(await BS.fetchProofForTransfer(row, ctx), null);
        });
    });

    describe('deterministic checkpoint selection', function(){

        function selectorCtx(anchorRows, mirrorRows){
            const { ctx } = makeCtx({ coin: 'DOGE' });
            ctx.indexerDb.doQuery = async (sql) => (/FROM anchor_actions/.test(sql) ? anchorRows : []);
            ctx.indexerDb._mirrorDb = () => ({ doQuery: async () => mirrorRows });
            return ctx;
        }

        it('takes the LOWEST height at or after snapshot_block, and the highest seq at it', async function(){
            const row = makeTransfer([], {});
            // The SQL does the ordering on a real database; the merge across sources is what
            // this asserts, so both sources are handed their own best row and the merge picks.
            const ctx = selectorCtx([{ chain: 'BTC', network: NETWORK, block_index: 1500, checkpoint_seq: 9,
                                       snapshot_block: 1500, state_root: 'a'.repeat(64), state_root_version: 1 }],
                                    []);
            const picked = await PC.selectCheckpoint(row, ctx);
            assert.strictEqual(picked.block_index, 1500);
            assert.strictEqual(picked.checkpoint_seq, 9);
            assert.strictEqual(picked.source, 'anchor_actions');
        });

        it('prefers a lower mirrored height over a higher locally anchored one', async function(){
            const row = makeTransfer([], {});
            const mirrored = [{ chain: 'BTC', network: NETWORK, block_index: 1210, checkpoint_seq: 2,
                                snapshot_block: 1210, state_root: 'b'.repeat(64), state_root_version: 1,
                                block_hash: 'h', ledger_hash: 'l', actions_hash: 'a', contract_hash: 'c',
                                block_merkle_root: 'm', block_merkle_version: 1, validator_signatures: '[]' }];
            const ctx = selectorCtx([{ chain: 'BTC', network: NETWORK, block_index: 1500, checkpoint_seq: 9,
                                       snapshot_block: 1500, state_root: 'a'.repeat(64), state_root_version: 1 }],
                                    mirrored);
            // The mirrored row's quorum is re-verified before it becomes a candidate; with an
            // empty signature list it does NOT, so the anchored row is still the pick. That is
            // the fail-closed direction: an unverified mirror row is not a candidate at all.
            const picked = await PC.selectCheckpoint(row, ctx);
            assert.strictEqual(picked.block_index, 1500);
        });

        it('admits a mirrored row only once its own quorum re-verifies', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const cp = { chain: 'BTC', network: NETWORK, block_index: 1210, checkpoint_seq: 2,
                         snapshot_block: 1210, state_root: 'b'.repeat(64), state_root_version: 1,
                         block_hash: 'hash', ledger_hash: 'ledger', actions_hash: 'actions',
                         contract_hash: 'contract', block_merkle_root: 'merkle', block_merkle_version: 1 };
            cp.validator_signatures = JSON.stringify(
                keys.map(k => ({ pubkey: k.pubkey, sig: sign(k.privateKey, PC.checkpointCanonical(cp)) })));
            const row = makeTransfer([], {});
            const ctx = selectorCtx([], [cp]);
            ctx.indexerDb.getValidatorsByCapability   = async () => snapshotSet(keys);
            ctx.indexerDb.getStakeWeightsByCapability = async () => snapshotSet(keys);
            assert.strictEqual(await PC.verifyCheckpointQuorum(cp, ctx.indexerDb), true);
            const picked = await PC.selectCheckpoint(row, ctx);
            assert.strictEqual(picked.block_index, 1210);
            assert.strictEqual(picked.source, 'state_checkpoints');

            // Flip one signature to a forgery and the row stops being a candidate: the whole
            // cross-check is vacuous if an unverified root can be handed to it.
            const forged = Object.assign({}, cp, { validator_signatures: JSON.stringify(
                keys.map(k => ({ pubkey: k.pubkey, sig: sign(k.privateKey, 'not this checkpoint') }))) });
            assert.strictEqual(await PC.verifyCheckpointQuorum(forged, ctx.indexerDb), false);
            const ctx2 = selectorCtx([], [forged]);
            ctx2.indexerDb.getValidatorsByCapability   = async () => snapshotSet(keys);
            ctx2.indexerDb.getStakeWeightsByCapability = async () => snapshotSet(keys);
            assert.strictEqual(await PC.selectCheckpoint(row, ctx2), null);
        });

        it('resolves the origin indexer endpoint through the three-tier idiom', function(){
            const saved = process.env.BTC_INDEXER_API_URL;
            delete process.env.BTC_INDEXER_API_URL;
            try {
                assert.strictEqual(PC.resolveOriginEndpoint('BTC', { BTC_INDEXER_URL: 'http://cfg:3000/' }).url,
                                   'http://cfg:3000/');
                process.env.BTC_INDEXER_API_URL = 'http://env:3000/';
                assert.strictEqual(PC.resolveOriginEndpoint('BTC', { BTC_INDEXER_URL: 'http://cfg:3000/' }).url,
                                   'http://env:3000/');
                assert.strictEqual(PC.resolveOriginEndpoint('not-a-coin', {}).url, '');
            } finally {
                if(saved === undefined) delete process.env.BTC_INDEXER_API_URL;
                else process.env.BTC_INDEXER_API_URL = saved;
            }
        });
    });

    describe('SLASH: the bridge engines are a slashable family', function(){

        // Driven through the real handler, not read off a map: ENGINE_CAPABILITY is
        // module-private, so the observable behaviour IS the test. The capability lookup sits
        // BEFORE the signature check in parse(), so a deliberately invalid signature is enough
        // to separate "mapped" from "not slashable" without building a real equivocation.
        function slashProbe(tag, roundId, contentA, contentB){
            const Slash = require('../../src/actions/slash.js');
            const cfg   = { COIN: 'BTC', NETWORK: NETWORK, GAS: 'XCHAIN' };
            const s = new Slash({ config: cfg, decoderDb: {}, util: new Utility(cfg),
                                  mapper: { createMappings: async () => {} },
                                  indexerDb: { updateBalances: async () => {}, updateTokens: async () => {},
                                               createSlash: async () => {} } });
            const b64  = (x) => Buffer.from(x, 'utf8').toString('base64url');
            const a    = eq.buildEquivCanonical(tag, roundId, 0, contentA);
            const b    = eq.buildEquivCanonical(tag, roundId, 0, contentB);
            const data = { FORMAT: 0, COIN: 'BTC', BLOCK_INDEX: 100, ACTION: 'SLASH' };
            return s.parse([0, 'cross_chain', 'ab'.repeat(32), b64(a), 'ff'.repeat(64), b64(b), 'ee'.repeat(64)],
                           data, null)
                    .then(() => data['STATUS'], () => data['STATUS']);
        }

        it('maps XBRIDGE and XPOLICY to a capability, where an unmapped tag is refused', async function(){
            const control = await slashProbe(eq.ENGINE_TAGS.NODEPROOF, 'z', 'X|1', 'X|2');
            assert.strictEqual(control, 'invalid: ENGINE_TAG (not slashable)',
                'the control must stop AT the capability gate, or the cases below prove nothing');
            for(const tag of [eq.ENGINE_TAGS.BRIDGE, eq.ENGINE_TAGS.POLICY]){
                const got = await slashProbe(tag, 'a'.repeat(64), tag + '|a|1200|X', tag + '|a|1200|Y');
                assert.notStrictEqual(got, control, tag + ' is not a slashable family');
                assert.strictEqual(got, 'invalid: SIG_A (does not verify)',
                    tag + ' should reach the signature check, i.e. past the capability gate');
            }
        });

        it('resolves each bridge canonical slot from snapshot_block at field index 2', async function(){
            const Slash = require('../../src/actions/slash.js');
            const cfg   = { COIN: 'BTC', NETWORK: NETWORK, GAS: 'XCHAIN' };
            const s = new Slash({ config: cfg, decoderDb: {}, indexerDb: {}, util: new Utility(cfg), mapper: {} });
            // Without a field entry this returns 'invalid: ENGINE_TAG (no snapshot_block rule)'
            // and the capability mapping above would be inert: a real forgery would burn nothing.
            assert.deepStrictEqual(
                await s._resolveSlot(eq.ENGINE_TAGS.BRIDGE, 'a'.repeat(64),
                                     'XBRIDGE|a|1200|X', 'XBRIDGE|a|1200|Y', false),
                { snapshotBlock: SNAPSHOT });
            assert.deepStrictEqual(
                await s._resolveSlot(eq.ENGINE_TAGS.POLICY, 'd'.repeat(64),
                                     'XPOLICY|d|1200|X', 'XPOLICY|d|1200|Y', false),
                { snapshotBlock: SNAPSHOT });
            // The two contents must agree on the height, or the pair names no shared slot.
            const mismatched = await s._resolveSlot(eq.ENGINE_TAGS.BRIDGE, 'a'.repeat(64),
                                                    'XBRIDGE|a|1200|X', 'XBRIDGE|a|1300|Y', false);
            assert.ok(mismatched.error, 'a height mismatch must not resolve a slot');
        });

        it('reads the height out of the canonical this module actually builds', function(){
            // The field index is only right if the canonical really carries snapshot_block
            // third. Read it back off the module's own builders rather than off a literal.
            const t = BS.transferCanonical(makeTransfer([], {}));
            const p = BS.policyCanonical({ snapshot_id: 'd'.repeat(64), snapshot_block: SNAPSHOT,
                                           origin_chain: 'BTC', tick: 'PEPECASH', policy_seq: 1,
                                           origin_block: 500, policy_hash: 'f'.repeat(64),
                                           effective_time: 1000, network: NETWORK, finalizing_view: 0 });
            const content = (wrapped) => wrapped.slice(wrapped.indexOf('||') + 2);
            assert.strictEqual(content(t).split('|')[2], String(SNAPSHOT));
            assert.strictEqual(content(p).split('|')[2], String(SNAPSHOT));
        });
    });

    describe('the pass position and ordering', function(){

        it('runs policy snapshots at the HEAD, before any transfer leg', async function(){
            const order = [];
            const { ctx } = makeCtx({ coin: 'DOGE' });
            ctx.indexerDb._mirrorDb = () => ({ doQuery: async (sql) => {
                order.push(/policy_snapshots/.test(sql) ? 'policy' : 'transfer');
                return [];
            }});
            await BS.processBridgeSettlePass(ctx);
            assert.deepStrictEqual(order, ['policy', 'transfer'],
                'the membership a snapshot materializes gates the credits the transfer legs apply');
        });

        it('clears ctx.proof when the pass ends, so no row inherits another row proof', async function(){
            const { ctx } = makeCtx({ coin: 'DOGE' });
            ctx.proof = { stale: true };
            await BS.processBridgeSettlePass(ctx);
            assert.strictEqual('proof' in ctx, false);
        });
    });
});

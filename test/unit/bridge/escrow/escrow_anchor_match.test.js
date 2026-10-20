/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION: a DOGE- or LTC-origin escrow checkpoint is selected
 * and bound on the BTC anchor axis (snapshot_block), and a BTC-origin one is not.
 *
 * The fixture is the testnet row of xchain-indexer issue 62: 100 papeto locked on DOGE at
 * block 67963860, finalized by the hub at BTC snapshot_block 155055, settling on BTC. The
 * old rule compared 155055 to DOGE block_index values and took the oldest DOGE checkpoint
 * held (67854584), from before the lock, so the proven escrow was short on every block.
 *
 * The database double applies each query's own predicate and ORDER BY to an in-memory
 * table, so a pick here is what the shipped SQL selects, not what the fixture pre-sorted.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const CHK    = require('../../../../src/consensus/bridge_checkpoint_check.js');
const bind   = require('../../../../src/consensus/bridge_checkpoint_check/bindings.js');
const PC     = require('../../../../src/consensus/bridge_proof_client.js');
const M      = require('../../../../src/consensus/merkle.js');
const SUB    = require('../../../../src/consensus/gates/state_subtree_gate.js');
const anchorsMixin = require('../../../../src/db/anchors');
const { ANCHOR_MATCH_KEY, anchorMatched } = require('../../../../src/consensus/bridge_checkpoint_check/anchor_match.js');
const { stubGate } = require('../../../helpers/gate_modules.js');
const { makeKey, sign, snapshotSet } = require('../bridge_settle.test/helpers/settle_fixtures.js');

const R = CHK.ESCROW_PROOF_REASON;
const NET = 'testnet';
const SNAP = 155055;           // the row's snapshot_block: a BTC height
const LOCK_BLOCK = 67963860;   // the DOGE block the lock was mined in

function cp(chain, blockIndex, snapshotBlock, seq){
    return { chain, network: NET, block_index: blockIndex, checkpoint_seq: seq === undefined ? snapshotBlock : seq,
             snapshot_block: snapshotBlock, state_root: 'a'.repeat(64), state_root_version: 2 };
}

// DOGE checkpoints held on the testnet BTC indexer around the lock, oldest first.
const DOGE_CPS = [
    cp('DOGE', 67854584, 152200),   // 2026-08-28, the old rule's pick
    cp('DOGE', 67963500, 155050),   // the interval before the stamp, below the lock
    cp('DOGE', 67964142, 155056),   // the first interval after the stamp, 282 blocks above the lock
    cp('DOGE', 67964500, 155062),
];

// BTC checkpoints sit CHECKPOINT_CONFIRMATIONS (6) below their own anchor.
const BTC_CPS = [
    cp('BTC', 155044, 155050),
    cp('BTC', 155050, 155056),
    cp('BTC', 155056, 155062),
];

// Apply the WHERE ranges and ORDER BY the SQL names to `rows`, the way MariaDB would.
function applySql(sql, args, rows){
    const where = /\bWHERE\b([\s\S]*?)\bORDER\s+BY\b/i.exec(sql)[1];
    const order = /\bORDER\s+BY\b([\s\S]*?)\bLIMIT\b/i.exec(sql)[1];
    const limit = Number(/\bLIMIT\s+(\d+)/i.exec(sql)[1]);
    const chain = args[args.length - 3], network = args[args.length - 2], bound = Number(args[args.length - 1]);
    let out = rows.filter(r => r.chain === chain && r.network === network && r.state_root);
    const ge = /\b(block_index|snapshot_block)\s*>=\s*\?/.exec(where);
    const gt = /\b(block_index|snapshot_block)\s*>\s*\?/.exec(where);
    if(ge) out = out.filter(r => Number(r[ge[1]]) >= bound);
    else if(gt) out = out.filter(r => Number(r[gt[1]]) > bound);
    else throw new Error('no range in ' + where);
    const terms = order.split(',').map(t => t.trim().replace(/^a\./, '').split(/\s+/))
        .filter(([col]) => col in (rows[0] || {}));
    out.sort((x, y) => {
        for(const [col, dir] of terms){
            const d = Number(x[col]) - Number(y[col]);
            if(d) return /DESC/i.test(dir) ? -d : d;
        }
        return 0;
    });
    return out.slice(0, limit);
}

// A settle-pass ctx for a leg settling on BTC, whose two checkpoint sources are the real
// db mixin methods over in-memory anchor_actions and state_checkpoints tables.
function selectorCtx(anchorRows, mirrorRows, extra){
    const calls = [];
    const db = {
        doQueryStrict: async (sql, args) => { calls.push(sql); return applySql(sql, args, anchorRows); },
        mirrorDb: () => ({ doQueryStrict: async (sql, args) => { calls.push(sql); return applySql(sql, args, mirrorRows); } }),
    };
    for(const m of ['getEarliestValidAnchorCheckpoint', 'getMirroredStateCheckpointCandidates',
                    'getEarliestValidAnchorCheckpointAfterAnchor', 'getMirroredStateCheckpointCandidatesAfterAnchor'])
        db[m] = anchorsMixin[m].bind(db);
    const ctx = Object.assign({ indexerDb: db, coin: 'BTC', network: NET, blockIndex: 157500 }, extra || {});
    return { ctx, calls };
}

function dogeRow(overrides){
    return Object.assign({ transfer_id: '4d6b21baa37a4da9' + '0'.repeat(48), snapshot_block: SNAP, network: NET,
                           src_chain: 'DOGE', src_action_index: 4369, dest_chain: 'BTC', tick: 'papeto',
                           decimals: 0, amount: '100' }, overrides || {});
}

function registerRegistryRow(){
    it('ships unarmed on mainnet and testnet and armed on regtest from genesis', function(){
        const gates = require('../../../../src/consensus/gate_registry');
        assert.strictEqual(gates.activeAt(ANCHOR_MATCH_KEY, 'mainnet', 'BTC', 99999999, null), false);
        assert.strictEqual(gates.activeAt(ANCHOR_MATCH_KEY, 'testnet', 'BTC', 157234, null), false);
        assert.strictEqual(gates.activeAt(ANCHOR_MATCH_KEY, 'testnet', 'BTC', 157235, null), true);
        assert.strictEqual(gates.activeAt(ANCHOR_MATCH_KEY, 'regtest', 'BTC', 0, null), true);
    });

    it('applies to DOGE and LTC origins only, read at the settling chain\'s own block', function(){
        const gate = stubGate(sinon, ANCHOR_MATCH_KEY, true);
        const ctx = { coin: 'BTC', network: NET, blockIndex: 157500 };
        assert.strictEqual(anchorMatched('DOGE', ctx), true);
        assert.strictEqual(anchorMatched('LTC', ctx), true);
        assert.strictEqual(anchorMatched('BTC', ctx), false);
        assert.ok(gate.calledWith(NET, 'BTC', 157500, null));
        gate.returns(false);
        assert.strictEqual(anchorMatched('DOGE', ctx), false);
    });
}

function registerDogeSelection(){
    it('a DOGE-origin row picks the oldest DOGE checkpoint below the gate and the anchor-matched one above it', async function(){
        const gate = stubGate(sinon, ANCHOR_MATCH_KEY, false);
        const before = selectorCtx(DOGE_CPS, []);
        const old = await PC.selectCheckpoint(dogeRow(), before.ctx);
        assert.strictEqual(old.block_index, 67854584, 'below the gate the old block_index rule is kept exactly');
        assert.ok(old.block_index < LOCK_BLOCK);

        gate.returns(true);
        const after = selectorCtx(DOGE_CPS, []);
        const picked = await PC.selectCheckpoint(dogeRow(), after.ctx);
        assert.strictEqual(picked.block_index, 67964142);
        assert.strictEqual(picked.snapshot_block, 155056);
        assert.strictEqual(picked.source, 'anchor_actions');
        assert.ok(picked.block_index >= LOCK_BLOCK, 'the anchor-matched checkpoint commits the lock');
        assert.ok(after.calls.every(sql => /snapshot_block > \?/.test(sql) && !/block_index >= \?/.test(sql)));
    });

    it('skips a checkpoint at the stamp\'s own BTC height: it can be led before the stamp', async function(){
        stubGate(sinon, ANCHOR_MATCH_KEY, true);
        const rows = DOGE_CPS.concat([cp('DOGE', 67963800, SNAP)]);
        const { ctx } = selectorCtx(rows, []);
        assert.strictEqual((await PC.selectCheckpoint(dogeRow(), ctx)).snapshot_block, 155056);
    });

    it('takes the highest checkpoint_seq at the lowest qualifying snapshot_block', async function(){
        stubGate(sinon, ANCHOR_MATCH_KEY, true);
        const rows = [cp('DOGE', 67964100, 155056, 900), cp('DOGE', 67964142, 155056, 901), cp('DOGE', 67964500, 155062)];
        const { ctx } = selectorCtx(rows, []);
        const picked = await PC.selectCheckpoint(dogeRow(), ctx);
        assert.strictEqual(picked.checkpoint_seq, 901);
        assert.strictEqual(picked.block_index, 67964142);
    });

    it('applies the same rule to an LTC origin', async function(){
        stubGate(sinon, ANCHOR_MATCH_KEY, true);
        const rows = [cp('LTC', 4905000, 152200), cp('LTC', 4910010, 155056)];
        const { ctx } = selectorCtx(rows, []);
        const picked = await PC.selectCheckpoint(dogeRow({ src_chain: 'LTC' }), ctx);
        assert.strictEqual(picked.block_index, 4910010);
    });

    it('stalls (no pick) while no checkpoint above the stamp is held', async function(){
        stubGate(sinon, ANCHOR_MATCH_KEY, true);
        const { ctx } = selectorCtx(DOGE_CPS.slice(0, 2), []);
        assert.strictEqual(await PC.selectCheckpoint(dogeRow(), ctx), null);
    });

}

function registerMergeAndBtcSelection(){
    it('merges a verified mirrored row with the anchored one on snapshot_block, not block_index', async function(){
        stubGate(sinon, ANCHOR_MATCH_KEY, true);
        const keys = [makeKey(), makeKey(), makeKey()];
        // Mirrored: the lower snapshot_block but the HIGHER block_index of the two, so a
        // merge still sorting on block_index would take the anchored row instead.
        const mirrored = Object.assign(cp('DOGE', 67964900, 155056), {
            network: 'regtest', block_hash: 'hash', ledger_hash: 'ledger', actions_hash: 'actions',
            contract_hash: 'contract', block_merkle_root: 'merkle', block_merkle_version: 1 });
        mirrored.validator_signatures = JSON.stringify(
            keys.map(k => ({ pubkey: k.pubkey, sig: sign(k.privateKey, PC.checkpointCanonical(mirrored)) })));
        const anchored = Object.assign(cp('DOGE', 67964700, 155062), { network: 'regtest' });
        const { ctx } = selectorCtx([anchored], [mirrored], { network: 'regtest' });
        ctx.indexerDb.getValidatorsByCapability   = async () => snapshotSet(keys);
        ctx.indexerDb.getStakeWeightsByCapability = async () => snapshotSet(keys);
        const picked = await PC.selectCheckpoint(dogeRow({ network: 'regtest' }), ctx);
        assert.strictEqual(picked.source, 'state_checkpoints');
        assert.strictEqual(picked.snapshot_block, 155056);
    });

    it('a BTC-origin row picks by block_index whether or not the gate is armed', async function(){
        const btcRow = dogeRow({ src_chain: 'BTC', dest_chain: 'DOGE', tick: 'XCHAIN', amount: '1' });
        const ctxArgs = { coin: 'DOGE' };
        const picks = [];
        for(const armed of [false, true]){
            sinon.restore();
            const gate = stubGate(sinon, ANCHOR_MATCH_KEY, armed);
            const { ctx, calls } = selectorCtx(BTC_CPS, [], ctxArgs);
            picks.push(await PC.selectCheckpoint(btcRow, ctx));
            assert.ok(calls.every(sql => /block_index >= \?/.test(sql) && !/snapshot_block > \?/.test(sql)),
                      'the BTC origin issues only the block_index reads');
            assert.strictEqual(gate.stub.withArgs(ANCHOR_MATCH_KEY).callCount, 0, 'and never reads the gate');
        }
        assert.deepStrictEqual(picks[0], picks[1]);
        assert.strictEqual(picks[0].block_index, 155056, 'the first BTC checkpoint at or after 155055');
    });
}

const proofFor = (c) => ({ checkpoint: c });
const dogeFields = (armed) => ({ originChain: 'DOGE', rowNet: NET, snapshot: SNAP, anchorMatched: armed });


function registerStaleness(){
    it('anchor-matched: binds a checkpoint above the stamp and refuses one at or below it', function(){
        assert.ok(bind.bindCheckpoint(proofFor(cp('DOGE', 67964142, 155056)), dogeFields(true)).cp);
        for(const s of [SNAP, 155050]){
            assert.strictEqual(bind.bindCheckpoint(proofFor(cp('DOGE', 67964142, s)), dogeFields(true)).verdict.reason,
                               R.CHECKPOINT_STALE, 'snapshot_block ' + s);
        }
        const noAnchor = Object.assign(cp('DOGE', 67964142, 155056), { snapshot_block: null });
        assert.strictEqual(bind.bindCheckpoint(proofFor(noAnchor), dogeFields(true)).verdict.reason, R.CHECKPOINT_STALE);
    });

    it('below the gate the old block_index bound is kept exactly, vacuous as it is for DOGE', function(){
        assert.ok(bind.bindCheckpoint(proofFor(cp('DOGE', 67854584, 152200)), dogeFields(false)).cp);
    });

    it('a BTC origin keeps the block_index bound', function(){
        const f = { originChain: 'BTC', rowNet: NET, snapshot: SNAP, anchorMatched: false };
        assert.ok(bind.bindCheckpoint(proofFor(cp('BTC', 155056, 155062)), f).cp);
        assert.ok(bind.bindCheckpoint(proofFor(cp('BTC', SNAP, 155061)), f).cp);
        assert.strictEqual(bind.bindCheckpoint(proofFor(cp('BTC', 155050, 155056)), f).verdict.reason, R.CHECKPOINT_STALE);
    });

    it('screenLeg carries the axis: armed for a DOGE-origin in leg, never for a BTC-origin one', function(){
        stubGate(sinon, ANCHOR_MATCH_KEY, true);
        const ctx = { coin: 'BTC', network: NET, blockIndex: 157500 };
        assert.strictEqual(bind.screenLeg(dogeRow(), ctx).fields.anchorMatched, true);
        const btcRow = dogeRow({ src_chain: 'BTC', dest_chain: 'DOGE', tick: 'XCHAIN' });
        assert.strictEqual(bind.screenLeg(btcRow, { coin: 'DOGE', network: NET, blockIndex: 157500 }).fields.anchorMatched, false);
    });
}

// A real envelope at a DOGE checkpoint whose escrow holds the 100 locked units.
function envelope(blockIndex, snapshotBlock){
    const escrow = CHK.resolveEscrowAddress('DOGE', 'BTC', NET);
    const smt = new M.SparseMerkleTree();
    const key = M.balanceKey('DOGE', NET, escrow, 'papeto');
    smt.set(key, M.amountLeaf('100'));
    const subRoots = { balances_root: smt.rootHex(), stakes_root: M.toHex(M.EMPTY_SMT_ROOT) };
    return { chain: 'DOGE', network: NET, block_index: blockIndex, sub_roots: subRoots, address: escrow,
             tick: 'papeto', balance: '100', balance_proof: { siblings: smt.prove(key).siblings },
             checkpoint: { chain: 'DOGE', network: NET, block_index: blockIndex, checkpoint_seq: snapshotBlock,
                           snapshot_block: snapshotBlock, state_root: M.toHex(M.stateRoot(subRoots)),
                           state_root_version: SUB.stateRootVersion(blockIndex, NET, 'DOGE') } };
}


function registerWholeCheck(){
    it('verifies at the anchor-matched checkpoint and refuses one at the stamp\'s own height once armed', function(){
        const gate = stubGate(sinon, ANCHOR_MATCH_KEY, true);
        const ctx = (proof) => ({ coin: 'BTC', network: NET, blockIndex: 157500, proof });
        assert.deepStrictEqual(CHK.verifyEscrowAgainstCheckpoint(dogeRow(), ctx(envelope(67964142, 155056))),
                               { ok: true, reason: R.VERIFIED });
        assert.strictEqual(CHK.verifyEscrowAgainstCheckpoint(dogeRow(), ctx(envelope(67963800, SNAP))).reason,
                           R.CHECKPOINT_STALE);
        gate.returns(false);
        assert.strictEqual(CHK.verifyEscrowAgainstCheckpoint(dogeRow(), ctx(envelope(67963800, SNAP))).ok, true,
                           'below the gate the same envelope binds as before');
    });
}

describe('bridge escrow checkpoint on the BTC anchor axis (BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION) @regression @tier1', function(){
    afterEach(function(){ sinon.restore(); });

    describe('the registry row', registerRegistryRow);
    describe('selectCheckpoint', function(){
        registerDogeSelection();
        registerMergeAndBtcSelection();
    });
    describe('bindCheckpoint staleness', registerStaleness);
    describe('the whole check on the issue 62 row', registerWholeCheck);
});

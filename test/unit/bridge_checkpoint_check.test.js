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
 * D2: the escrow cross-check against the anchored state checkpoint
 * (the base bridge spec row 17; D2, D19, D46).
 *
 * WHAT THESE TESTS ARE FOR. The positive case is built from REAL cryptography, never from
 * a hand-written expectation: a sparse Merkle tree is populated with the escrow leaf, its
 * root is assembled into a state_root exactly the way the block path assembles one, and the
 * inclusion proof is produced by merkle.js itself. So "ok:true" means the same arithmetic a
 * producing node does, not that a fixture agreed with itself.
 *
 * THE FALSIFICATION CASES are the point of the file. Each one takes that same valid proof
 * and breaks exactly ONE thing a forger would have to control: the root, the balance, the
 * block, the address, the chain, the tick, the network. Every one must apply nothing. They
 * are written one-change-at-a-time on purpose: a forged envelope that differs in five
 * places would pass a weaker suite by failing on the wrong check.
 *
 * WHY THE VERSION CASES BUILD FIXTURES AT SEVERAL HEIGHTS. state_root_version is DERIVED per
 * height, chain and network (state_subtree_activation.stateRootVersion), and that is how the
 * fleet stamps it: api.js getblockhashes mints it at the block's own height and the hub's
 * checkpoint engine copies it verbatim into the signed canonical. A suite whose every fixture
 * sat at one height, stamped with the static merkle constant, would pass against a checker
 * that compared to that constant and so refused every checkpoint BTC:regtest has signed since
 * block 10000 and every checkpoint any testnet chain has ever signed. So the fixtures below
 * straddle the regtest boundary and include a testnet chain, and the first case asserts the
 * boundary is still where these heights assume it is.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const M      = require('../../src/merkle.js');
const SUB    = require('../../src/state_subtree_activation.js');
const CHK    = require('../../src/bridge_checkpoint_check.js');

const R = CHK.ESCROW_PROOF_REASON;

// The rail's shape: XCHAIN locked on BTC to a DOGE address, DOGE mints (spec AT1).
const NETWORK     = 'regtest';
const ORIGIN      = 'BTC';
const DEST        = 'DOGE';
const TICK        = 'XCHAIN';
// One escrow address per network, and deliberately DIFFERENT strings. The balance key commits
// chain and network, so a resolver that read the role at the wrong network would derive a
// different key and a different address, and the testnet cases below would stop verifying
// instead of quietly proving the same fixture twice.
const ESCROW_ADDRS = {
    regtest: 'mBridgeDogeEscrowXXXXXXXXXXXXXXXXX',
    testnet: 'mBridgeDogeEscrowTestnetXXXXXXXXXX',
};
const ESCROW_ADDR = ESCROW_ADDRS[NETWORK];
const SNAPSHOT    = 1200;
const CP_HEIGHT   = 1205;          // the first checkpoint at or after snapshot_block

// Heights the sub-tree activation maps really key on today, measured not assumed:
// contract_state_root arms on BTC:regtest at 10000 and the balances_root escrow leaf at
// 11200, so regtest is the one chain with a boundary on both sides. All three testnet chains
// are armed from genesis, so testnet has no below-boundary side at all and every genuine
// testnet checkpoint carries version 2. The first case in the version block asserts all of
// this, so a map move retires these fixtures loudly rather than collapsing them into one case.
const V1_HEIGHT        = 9999;     // BTC:regtest, below contract_state_root
const V2_HEIGHT        = 10000;    // BTC:regtest, at contract_state_root
const V2_ESCROW_HEIGHT = 11200;    // BTC:regtest, at the escrow locked leaf
const TESTNET_HEIGHT   = 150000;   // BTC:testnet, an ordinary live height

// A second, unrelated balance leaf, so balances_root is not a one-leaf tree and the escrow
// proof carries real siblings rather than the empty constants at every depth.
const OTHER_ADDR  = 'mSomeOtherHolderXXXXXXXXXXXXXXXXXX';

// Build a balances sub-tree holding the escrow balance plus one unrelated holder, and return
// everything a producer would hand over: the root, the escrow inclusion proof, and the tree
// itself for the tests that need to re-prove a different key.
function buildBalances(escrowBalance, network){
    const net    = network || NETWORK;
    const escrow = ESCROW_ADDRS[net];
    const smt = new M.SparseMerkleTree();
    if(M.canonicalAmount(escrowBalance) !== M.canonicalAmount('0'))
        smt.set(M.balanceKey(ORIGIN, net, escrow, TICK), M.amountLeaf(escrowBalance));
    smt.set(M.balanceKey(ORIGIN, net, OTHER_ADDR, TICK), M.amountLeaf('41.5'));
    return {
        smt,
        root:  smt.rootHex(),
        proof: smt.prove(M.balanceKey(ORIGIN, net, escrow, TICK)),
    };
}

// A full, valid envelope for an escrow holding `escrowBalance`. Sub-roots are assembled the
// way stateCommitment.assembleStateRoot assembles them, so the checkpoint's state_root is a
// real state_root and not a stand-in.
//
// opts: { network, cpHeight, version, subRoots }. `version` defaults to the DERIVED value at
// the fixture's own height, chain and network, which is what a producing node stamps
// (api.js getblockhashes) and what the hub copies into the signed canonical. Passing it
// explicitly is how the refusal cases stamp a wrong one. `subRoots` adds named slots beyond
// the two a v1 assembly commits, for the version-2 layout cases.
function buildProof(escrowBalance, opts){
    const o       = opts || {};
    const net     = o.network  || NETWORK;
    const height  = (o.cpHeight !== undefined) ? o.cpHeight : CP_HEIGHT;
    const version = (o.version  !== undefined) ? o.version  : SUB.stateRootVersion(height, net, ORIGIN);
    const balances = buildBalances(escrowBalance, net);
    const subRoots = Object.assign(
        { balances_root: balances.root, stakes_root: M.toHex(M.EMPTY_SMT_ROOT) },
        o.subRoots || {});
    return {
        chain:       ORIGIN,
        network:     net,
        block_index: height,
        sub_roots:   subRoots,
        address:     ESCROW_ADDRS[net],
        tick:        TICK,
        balance:     escrowBalance,
        balance_proof: { siblings: balances.proof.siblings },
        checkpoint: {
            chain:              ORIGIN,
            network:            net,
            block_index:        height,
            checkpoint_seq:     77,
            snapshot_block:     height,
            state_root:         M.toHex(M.stateRoot(subRoots)),
            state_root_version: version,
        },
        _balances: balances,   // test-only handle, ignored by the verifier
    };
}

function buildRow(overrides){
    return Object.assign({
        transfer_id:     'a'.repeat(64),
        snapshot_block:  SNAPSHOT,
        network:         NETWORK,
        src_chain:       ORIGIN,
        src_action_index: 9001,
        src_address:     '1SomeLockerXXXXXXXXXXXXXXXXXXXXXXX',
        dest_chain:      DEST,
        dest_address:    'DSomeDogeDestinationXXXXXXXXXXXXXX',
        tick:            TICK,
        decimals:        8,
        amount:          '5.00000000',
        effective_time:  1750000000,
    }, overrides || {});
}

function buildCtx(proof, overrides){
    return Object.assign({
        actions: {}, indexerDb: {}, util: {}, config: {},
        coin: DEST, network: NETWORK, blockIndex: 500, blockTime: 1750000100,
        proof: proof,
    }, overrides || {});
}

describe('bridge_checkpoint_check: D2 escrow cross-check', function(){

    // The escrow address is resolved from the ORIGIN chain's own coin config, never from the
    // envelope. These tests stub that one door so they exercise the check itself rather than
    // the arrival of lane L2's BRIDGE_<COIN> role; the door itself is asserted separately at
    // the bottom of this file.
    let cfgStub;
    beforeEach(function(){
        const btc = require('../../src/configs/BTC.js');
        cfgStub = sinon.stub(btc, 'getConfig').callsFake(function(network){
            const addr = ESCROW_ADDRS[network];
            return { ADDRESS: addr ? { BRIDGE_DOGE: addr } : {} };
        });
    });
    afterEach(function(){ cfgStub.restore(); });

    describe('the positive case, built from a real checkpoint fixture', function(){

        it('accepts a proof whose sub-roots reassemble to the signed state_root and whose escrow covers the amount', function(){
            const proof = buildProof('12.34567890');
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, true, 'a genuine proof must verify: ' + out.reason);
            assert.strictEqual(out.reason, R.VERIFIED);
        });

        it('accepts the compressed wire form of the same proof', function(){
            const proof = buildProof('12.34567890');
            proof.balance_proof = { compressed: M.compressSmtProof(proof._balances.proof.siblings) };
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, true, 'the compressed form must verify too: ' + out.reason);
        });

        it('accepts a bare compressed envelope (bitmap plus siblings, no wrapper key)', function(){
            const proof = buildProof('12.34567890');
            proof.balance_proof = M.compressSmtProof(proof._balances.proof.siblings);
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, true, out.reason);
        });

        it('accepts an escrow balance exactly equal to the amount', function(){
            const proof = buildProof('5.00000000');
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow({ amount: '5' }), buildCtx(proof));
            assert.strictEqual(out.ok, true, out.reason);
        });

        it('accepts a checkpoint cut well after snapshot_block', function(){
            const proof = buildProof('12.34567890');
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow({ snapshot_block: 1 }), buildCtx(proof));
            assert.strictEqual(out.ok, true, out.reason);
        });

        it('accepts roots spelled in upper case', function(){
            const proof = buildProof('12.34567890');
            proof.sub_roots.balances_root = proof.sub_roots.balances_root.toUpperCase();
            proof.checkpoint.state_root   = proof.checkpoint.state_root.toUpperCase();
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, true, 'hex case is not a forgery: ' + out.reason);
        });
    });

    describe('falsification: one broken binding at a time applies nothing', function(){

        it('refuses a forged balances_root (the root the balance is proven under is not the signed one)', function(){
            // The forger builds its own tree with a fat escrow and swaps in its root, keeping
            // the checkpoint the quorum actually signed.
            const proof = buildProof('12.34567890');
            const forged = buildBalances('1000000.00000000');
            proof.sub_roots.balances_root = forged.root;
            proof.balance = '1000000.00000000';
            proof.balance_proof = { siblings: forged.proof.siblings };
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false, 'a self-made balances_root must not mint');
            assert.strictEqual(out.reason, R.ROOT_MISMATCH);
        });

        it('refuses a forged state_root on the checkpoint (sub-roots no longer reassemble to it)', function(){
            const proof = buildProof('12.34567890');
            proof.checkpoint.state_root = 'f'.repeat(64);
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.ROOT_MISMATCH);
        });

        it('refuses a forged balance claimed over a genuine proof of a different balance', function(){
            // Everything is the real checkpoint's; only the claimed number is inflated. The
            // leaf is derived from the claim, so the inclusion proof no longer verifies.
            const proof = buildProof('1.00000000');
            proof.balance = '999.00000000';
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false, 'a claim must not outrun its proof');
            assert.strictEqual(out.reason, R.PROOF_INVALID);
        });

        it('refuses when the genuinely proven escrow is below the transfer amount', function(){
            const proof = buildProof('4.99999999');
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow({ amount: '5.00000000' }), buildCtx(proof));
            assert.strictEqual(out.ok, false, 'a deficit must not mint');
            assert.strictEqual(out.reason, R.INSUFFICIENT);
        });

        it('refuses when the escrow holds nothing at all (non-membership proof)', function(){
            const proof = buildProof('0');
            proof.balance = '0';
            proof.balance_proof = { siblings: proof._balances.proof.siblings };
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false, 'nothing locked must mint nothing');
            assert.strictEqual(out.reason, R.INSUFFICIENT);
        });

        it('refuses a checkpoint from BELOW the transfer snapshot_block (the stale-proof forgery)', function(){
            const proof = buildProof('12.34567890');
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow({ snapshot_block: CP_HEIGHT + 1 }), buildCtx(proof));
            assert.strictEqual(out.ok, false, 'a checkpoint that predates the lock proves nothing');
            assert.strictEqual(out.reason, R.CHECKPOINT_STALE);
        });

        it('refuses roots taken from a different height than the checkpoint commits', function(){
            const proof = buildProof('12.34567890');
            proof.block_index = CP_HEIGHT - 1;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.PROOF_BINDING);
        });

        it('refuses a proof of some other address, even one with a genuine inclusion proof', function(){
            // The classic substitution: prove a balance the forger controls and label it the
            // escrow. The address is resolved from config here, so the label is worthless.
            const proof = buildProof('12.34567890');
            proof.address = OTHER_ADDR;
            proof.balance = '41.5';
            proof.balance_proof = { siblings: proof._balances.smt.prove(
                M.balanceKey(ORIGIN, NETWORK, OTHER_ADDR, TICK)).siblings };
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false, 'another address is not the escrow');
            assert.strictEqual(out.reason, R.PROOF_BINDING);
        });

        it('refuses a proof of a different tick under the same escrow address', function(){
            const proof = buildProof('12.34567890');
            proof.tick = 'FUFU';
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.PROOF_BINDING);
        });

        it('refuses a checkpoint of the destination chain instead of the origin chain', function(){
            const proof = buildProof('12.34567890');
            proof.checkpoint.chain = DEST;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.CHECKPOINT_BINDING);
        });

        it('refuses a checkpoint from another network', function(){
            const proof = buildProof('12.34567890');
            proof.checkpoint.network = 'testnet';
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.CHECKPOINT_BINDING);
        });

        it('refuses a rootless checkpoint (pre-commitment flag-day row)', function(){
            const proof = buildProof('12.34567890');
            proof.checkpoint.state_root = null;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.CHECKPOINT_ROOTLESS);
        });

        it('refuses a state_root version this node does not derive at that height', function(){
            const proof = buildProof('12.34567890');
            proof.checkpoint.state_root_version = SUB.stateRootVersion(CP_HEIGHT, NETWORK, ORIGIN) + 1;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false, 'an unknown layout must fail closed');
            assert.strictEqual(out.reason, R.ROOT_VERSION);
        });

        it('refuses a truncated sibling list', function(){
            const proof = buildProof('12.34567890');
            proof.balance_proof = { siblings: proof._balances.proof.siblings.slice(0, 255) };
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.PROOF_INVALID);
        });

        it('refuses a compressed proof carrying surplus siblings without throwing out of the block loop', function(){
            const proof = buildProof('12.34567890');
            const compressed = M.compressSmtProof(proof._balances.proof.siblings);
            compressed.siblings.push('b'.repeat(64));
            proof.balance_proof = { compressed: compressed };
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.PROOF_MALFORMED);
        });

        it('refuses a sibling at one depth swapped for another hash', function(){
            const proof = buildProof('12.34567890');
            const siblings = proof._balances.proof.siblings.slice();
            siblings[200] = 'c'.repeat(64);
            proof.balance_proof = { siblings: siblings };
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.PROOF_INVALID);
        });
    });

    describe('state_root_version is the version DERIVED at the checkpoint height', function(){

        // This block exists because a static comparison against merkle.STATE_ROOT_VERSION
        // reads as correct on any fixture cut below a chain's first sub-tree flag day, and
        // refuses every checkpoint above one. The maps are the authority on where those days
        // fall, so this case pins the boundary the fixtures below are built around: if a map
        // moves, this fails first and names the heights that need re-choosing, instead of the
        // rest of the block silently degrading into five copies of the same height.
        it('the fixtures straddle a real boundary: regtest 1 below 10000 and 2 from it, testnet 2 from genesis', function(){
            assert.strictEqual(SUB.stateRootVersion(V1_HEIGHT, NETWORK, ORIGIN), 1);
            assert.strictEqual(SUB.stateRootVersion(V2_HEIGHT, NETWORK, ORIGIN), 2);
            assert.strictEqual(SUB.stateRootVersion(V2_ESCROW_HEIGHT, NETWORK, ORIGIN), 2);
            assert.strictEqual(SUB.stateRootVersion(0, 'testnet', ORIGIN), 2,
                'testnet arms from genesis, so it has no below-boundary side to test');
            assert.strictEqual(SUB.stateRootVersion(TESTNET_HEIGHT, 'testnet', ORIGIN), 2);
            assert.strictEqual(M.STATE_ROOT_VERSION, 1,
                'the static constant is 1, which is why comparing to it refuses every armed chain');
        });

        it('accepts a regtest checkpoint below the sub-tree boundary, stamped version 1', function(){
            const proof = buildProof('12.34567890', { cpHeight: V1_HEIGHT });
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, true, out.reason);
            assert.strictEqual(proof.checkpoint.state_root_version, 1);
        });

        it('accepts a regtest checkpoint AT the sub-tree boundary, stamped version 2', function(){
            // The regression. The fleet stamps 2 here, so a check against the static constant
            // refuses a genuine checkpoint and the destination chain can never mint.
            const proof = buildProof('12.34567890', { cpHeight: V2_HEIGHT });
            assert.strictEqual(proof.checkpoint.state_root_version, 2);
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, true, 'a genuine version-2 checkpoint must verify: ' + out.reason);
            assert.strictEqual(out.reason, R.VERIFIED);
        });

        it('accepts a regtest checkpoint at the escrow locked-leaf height, stamped version 2', function(){
            const proof = buildProof('12.34567890', { cpHeight: V2_ESCROW_HEIGHT });
            assert.strictEqual(proof.checkpoint.state_root_version, 2);
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, true, out.reason);
        });

        it('accepts a testnet checkpoint, which is version 2 at every height the chain has', function(){
            // The other half of the regression, and the one that matters on the rail: BTC
            // testnet arms from genesis, so EVERY checkpoint it has ever signed carries 2.
            const proof = buildProof('12.34567890', { network: 'testnet', cpHeight: TESTNET_HEIGHT });
            assert.strictEqual(proof.checkpoint.state_root_version, 2);
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow({ network: 'testnet' }), buildCtx(proof, { network: 'testnet' }));
            assert.strictEqual(out.ok, true, 'a genuine testnet checkpoint must verify: ' + out.reason);
            assert.strictEqual(out.reason, R.VERIFIED);
        });

        it('accepts a testnet checkpoint at genesis, where the boundary itself sits', function(){
            const proof = buildProof('12.34567890', { network: 'testnet', cpHeight: 0 });
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow({ network: 'testnet', snapshot_block: 0 }),
                buildCtx(proof, { network: 'testnet' }));
            assert.strictEqual(out.ok, true, out.reason);
        });

        it('accepts a version-2 checkpoint whose reserved slot carries a real sub-root', function(){
            // A version-2 chain with contract state commits a NON-empty contract_state_root,
            // so the five-slot assembly is the only one that reaches the signed state_root.
            const proof = buildProof('12.34567890', {
                cpHeight: V2_HEIGHT,
                subRoots: { contract_state_root: 'e'.repeat(64) },
            });
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, true, out.reason);
        });

        it('refuses a version-2 envelope that drops the reserved sub-root the checkpoint committed', function(){
            const proof = buildProof('12.34567890', {
                cpHeight: V2_HEIGHT,
                subRoots: { contract_state_root: 'e'.repeat(64) },
            });
            delete proof.sub_roots.contract_state_root;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false, 'a short assembly must not reach the signed root');
            assert.strictEqual(out.reason, R.ROOT_MISMATCH);
        });

        it('refuses a checkpoint at a version-2 height stamped the static merkle constant', function(){
            // The defect itself, inverted: a row claiming version 1 at a height the maps say
            // commits version 2 is a claim about a leaf set this node does not agree on.
            const proof = buildProof('12.34567890', {
                cpHeight: V2_HEIGHT, version: M.STATE_ROOT_VERSION,
            });
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false, 'a stale version stamp must fail closed');
            assert.strictEqual(out.reason, R.ROOT_VERSION);
        });

        it('refuses a checkpoint at a version-1 height stamped 2', function(){
            const proof = buildProof('12.34567890', { cpHeight: V1_HEIGHT, version: 2 });
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.ROOT_VERSION);
        });

        it('refuses a testnet checkpoint stamped 1, which no testnet chain can have signed', function(){
            const proof = buildProof('12.34567890', {
                network: 'testnet', cpHeight: TESTNET_HEIGHT, version: 1,
            });
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow({ network: 'testnet' }), buildCtx(proof, { network: 'testnet' }));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.ROOT_VERSION);
        });

        it('refuses a version field that is not a version, rather than coercing it to one', function(){
            // At this height the derived version is 1, which is exactly what a bare Number()
            // turns true into, and what an unwary parse turns '1abc' or 1.0000001 into. Each
            // of these must read as "no version", never as version 1.
            assert.strictEqual(SUB.stateRootVersion(CP_HEIGHT, NETWORK, ORIGIN), 1);
            for(const bad of [true, null, undefined, '1abc', '', ' 1 ', 1.5, -1, {}, [1], NaN]){
                // Assigned onto a built fixture, not passed as a build option: an option of
                // undefined would take the default and quietly test the happy path.
                const proof = buildProof('12.34567890');
                proof.checkpoint.state_root_version = bad;
                const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
                assert.strictEqual(out.ok, false, 'version ' + String(bad) + ' must not verify');
                assert.strictEqual(out.reason, R.ROOT_VERSION);
            }
        });

        it('refuses a checkpoint with no version field at all', function(){
            const proof = buildProof('12.34567890');
            delete proof.checkpoint.state_root_version;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false, 'an unversioned root is not a root this node can place');
            assert.strictEqual(out.reason, R.ROOT_VERSION);
        });

        it('accepts the version handed back as a digit string or a BigInt by the driver', function(){
            for(const good of ['1', BigInt(1)]){
                const proof = buildProof('12.34567890', { version: good });
                const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
                assert.strictEqual(out.ok, true, 'driver form ' + String(good) + ': ' + out.reason);
            }
        });
    });

    describe('a missing or unusable proof applies nothing', function(){

        it('refuses when no proof was fetched beside the row', function(){
            const ctx = buildCtx(undefined);
            delete ctx.proof;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), ctx);
            assert.strictEqual(out.ok, false, 'no proof is not permission to mint');
            assert.strictEqual(out.reason, R.PROOF_MISSING);
        });

        it('refuses a proof carrying no checkpoint', function(){
            const proof = buildProof('12.34567890');
            delete proof.checkpoint;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.CHECKPOINT_MISSING);
        });

        it('refuses a proof carrying no balances_root', function(){
            const proof = buildProof('12.34567890');
            delete proof.sub_roots.balances_root;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.PROOF_MALFORMED);
        });

        it('refuses a proof carrying no balance_proof', function(){
            const proof = buildProof('12.34567890');
            delete proof.balance_proof;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.PROOF_MALFORMED);
        });

        it('refuses a non-decimal balance claim rather than throwing', function(){
            const proof = buildProof('12.34567890');
            proof.balance = '-1';
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(proof));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.PROOF_MALFORMED);
        });

        it('refuses when the escrow role is absent from the origin chain config', function(){
            cfgStub.restore();
            cfgStub = sinon.stub(require('../../src/configs/BTC.js'), 'getConfig')
                .callsFake(function(){ return { ADDRESS: { BURN: 'x' } }; });
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(buildProof('12.34567890')));
            assert.strictEqual(out.ok, false, 'an unresolved escrow must fail closed');
            assert.strictEqual(out.reason, R.ESCROW_UNRESOLVED);
        });
    });

    describe('leg and row guards', function(){

        it('passes the OUT leg through: the escrow is a local balance on this chain', function(){
            // BTC applying the release of an escrow it holds itself, from a burn on DOGE. No
            // remote checkpoint can add anything, and the would-go-negative refusal in the
            // settle pass is the guard.
            const ctx = buildCtx(undefined, { coin: ORIGIN });
            delete ctx.proof;
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow({ src_chain: DEST, dest_chain: ORIGIN }), ctx);
            assert.strictEqual(out.ok, true, out.reason);
            assert.strictEqual(out.reason, R.OUT_LEG);
        });

        it('does not let a mint pose as an OUT leg by naming a non-escrow source chain', function(){
            // The forgery the leg rule has to survive: a row claiming an LTC source so that a
            // naive "src is not the escrow chain, therefore out leg" reading would skip the
            // cross-check and mint on DOGE with nothing locked anywhere.
            const ctx = buildCtx(undefined, { coin: DEST });
            delete ctx.proof;
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow({ src_chain: 'LTC', dest_chain: DEST }), ctx);
            assert.strictEqual(out.ok, false, 'a mint from a non-escrow chain must apply nothing');
            assert.strictEqual(out.reason, R.IN_LEG_ORIGIN);
        });

        it('still demands the proof on an in leg even when the escrow chain is the source', function(){
            // The exemption is keyed on THIS chain, so the ordinary BTC-to-DOGE mint gets no
            // relief from it: no proof, no mint.
            const ctx = buildCtx(undefined, { coin: DEST });
            delete ctx.proof;
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), ctx);
            assert.strictEqual(out.ok, false, 'the escrow-chain exemption must not travel with the row');
            assert.strictEqual(out.reason, R.PROOF_MISSING);
        });

        it('refuses a row that names neither side as this chain', function(){
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow(), buildCtx(buildProof('12.34567890'), { coin: 'LTC' }));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.NOT_THIS_CHAIN);
        });

        it('refuses a row whose network is not this indexer\'s', function(){
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow({ network: 'testnet' }), buildCtx(buildProof('12.34567890')));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.ROW_NETWORK);
        });

        it('refuses a row whose src_chain and dest_chain are the same', function(){
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow({ src_chain: DEST }), buildCtx(buildProof('12.34567890')));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.ROW_FIELDS);
        });

        it('refuses a zero or negative amount rather than passing it vacuously', function(){
            const proof = buildProof('12.34567890');
            for(const bad of ['0', '0.00000000', '-1', 'abc', null]){
                const out = CHK.verifyEscrowAgainstCheckpoint(buildRow({ amount: bad }), buildCtx(proof));
                assert.strictEqual(out.ok, false, 'amount ' + bad + ' must not verify');
                assert.strictEqual(out.reason, R.ROW_AMOUNT);
            }
        });

        it('refuses a missing row or context rather than throwing', function(){
            assert.strictEqual(CHK.verifyEscrowAgainstCheckpoint(null, buildCtx({})).ok, false);
            assert.strictEqual(CHK.verifyEscrowAgainstCheckpoint(buildRow(), null).ok, false);
        });

        it('refuses a snapshot_block that is not a height', function(){
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow({ snapshot_block: 'soon' }), buildCtx(buildProof('12.34567890')));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, R.ROW_FIELDS);
        });

        it('accepts a snapshot_block handed over as a BigInt by the driver', function(){
            const out = CHK.verifyEscrowAgainstCheckpoint(
                buildRow({ snapshot_block: BigInt(SNAPSHOT) }), buildCtx(buildProof('12.34567890')));
            assert.strictEqual(out.ok, true, out.reason);
        });
    });
});

describe('bridge_checkpoint_check: the escrow address door', function(){

    // NOT stubbed. This asserts the resolver reads the same place the lock handler credits,
    // so the two can never prove and fund different addresses. Lane L2 adds BRIDGE_<COIN> to
    // the BTC coin bundle and the config adapter's ADDRESS allowlist; until BOTH land the
    // role is absent and the resolver must say so rather than guess.
    it('resolves BRIDGE_<DEST> from the origin chain config, or nothing at all', function(){
        const live = require('../../src/configs/BTC.js').getConfig('regtest');
        const expected = (live && live.ADDRESS && live.ADDRESS.BRIDGE_DOGE) || null;
        assert.strictEqual(CHK.resolveEscrowAddress('BTC', 'DOGE', 'regtest'), expected,
            'the resolver must return exactly what the coin config exposes for the role');
    });

    it('returns null for an unknown chain rather than loading an arbitrary path', function(){
        assert.strictEqual(CHK.resolveEscrowAddress('../db', 'DOGE', 'regtest'), null);
        assert.strictEqual(CHK.resolveEscrowAddress('BTC', '../../etc/passwd', 'regtest'), null);
        assert.strictEqual(CHK.resolveEscrowAddress('NOPE', 'DOGE', 'regtest'), null);
    });
});

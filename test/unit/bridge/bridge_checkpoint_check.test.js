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
 * The escrow cross-check against the anchored state checkpoint
 * (proven before the destination chain mints).
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

const {
    assert, sinon, M, SUB, CHK, R, NETWORK, ORIGIN, DEST, TICK,
    ESCROW_ADDRS, ESCROW_ADDR, SNAPSHOT, CP_HEIGHT, V1_HEIGHT, V2_HEIGHT,
    V2_ESCROW_HEIGHT, TESTNET_HEIGHT, OTHER_ADDR, buildBalances, buildProof,
    buildRow, buildCtx, installBridgeHooks,
} = require('./bridge_checkpoint_check.test/helpers/setup.js');

const hookState = {};

function registerPositiveCases() {
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

}

function registerFalsificationRootCases() {
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
    });

}

function registerFalsificationBindingCases() {
    describe('falsification: one broken binding at a time applies nothing', function(){
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
    });

}

describe('bridge_checkpoint_check: D2 escrow cross-check', function(){
    installBridgeHooks(hookState);
    registerPositiveCases();
    registerFalsificationRootCases();
    registerFalsificationBindingCases();
});

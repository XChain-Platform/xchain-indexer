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
    assert, sinon, M, SUB, CHK, R, NETWORK, ORIGIN, DEST, TICK,
    ESCROW_ADDRS, ESCROW_ADDR, SNAPSHOT, CP_HEIGHT, V1_HEIGHT, V2_HEIGHT,
    V2_ESCROW_HEIGHT, TESTNET_HEIGHT, OTHER_ADDR, buildBalances, buildProof,
    buildRow, buildCtx, installBridgeHooks,
} = require('./helpers/setup.js');

const hookState = {};

function registerMalformedProofCases() {
    describe('falsification: one broken binding at a time applies nothing', function(){
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

}

function registerVersionBoundaryCases() {
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
    });

}

function registerVersionTwoAcceptCases() {
    describe('state_root_version is the version DERIVED at the checkpoint height', function(){
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

    });
}

function registerVersionTwoRefusalCases() {
    describe('state_root_version is the version DERIVED at the checkpoint height', function(){
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
    });

}

function registerVersionDriverCases() {
    describe('state_root_version is the version DERIVED at the checkpoint height', function(){
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

}

describe('bridge_checkpoint_check: D2 escrow cross-check', function(){
    installBridgeHooks(hookState);
    registerMalformedProofCases();
    registerVersionBoundaryCases();
    registerVersionTwoAcceptCases();
    registerVersionTwoRefusalCases();
    registerVersionDriverCases();
});



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

function registerMissingProofCases() {
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
            hookState.cfgStub.restore();
            hookState.cfgStub = sinon.stub(require('../../../src/coins/to_indexer_config.js'), 'toIndexerConfig')
                .callsFake(function(){ return { ADDRESS: { BURN: 'x' } }; });
            const out = CHK.verifyEscrowAgainstCheckpoint(buildRow(), buildCtx(buildProof('12.34567890')));
            assert.strictEqual(out.ok, false, 'an unresolved escrow must fail closed');
            assert.strictEqual(out.reason, R.ESCROW_UNRESOLVED);
        });
    });

}

function registerLegGuardCases() {
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
    });

}

function registerRowGuardCases() {
    describe('leg and row guards', function(){
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
}

describe('bridge_checkpoint_check: D2 escrow cross-check', function(){
    installBridgeHooks(hookState);
    registerMissingProofCases();
    registerLegGuardCases();
    registerRowGuardCases();
});

describe('bridge_checkpoint_check: the escrow address door', function(){

    // NOT stubbed. This asserts the resolver reads the same place the lock handler credits,
    // so the two can never prove and fund different addresses. The BRIDGE_<COIN> role goes into
    // the BTC coin bundle and the config adapter's ADDRESS allowlist; until BOTH land the
    // role is absent and the resolver must say so rather than guess.
    it('resolves BRIDGE_<DEST> from the origin chain config, or nothing at all', function(){
        const live = require('../../../src/coins/to_indexer_config.js').toIndexerConfig('BTC', 'regtest');
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

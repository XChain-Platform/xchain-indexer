/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/anchor/anchor_reward_derive.test/derive_loop_pin.test.js
 *
 * Pins deriveAnchorRewards' per-row mint loop (grouping, mint-call count and
 * reconcile-call count) against today's behavior, with the proof-and-mint
 * step (anchor_reward_derive/mint_row.js) swapped out via require.cache so
 * later wiring inside that step cannot silently change the loop's outputs.
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const swq = require('../../../../src/consensus/stake_weighted_quorum.js');
const ar  = require('../../../../src/consensus/gates/anchor_reward_gate.js');
const realMintRow = require('../../../../src/consensus/anchor_reward_derive/mint_row.js');

const DERIVE_PATH   = require.resolve('../../../../src/consensus/anchor_reward_derive.js');
const MINT_ROW_PATH = require.resolve('../../../../src/consensus/anchor_reward_derive/mint_row.js');

// Ed25519 keypair whose raw 32-byte pubkey / 64-byte sig hex match src/consensus/ed25519.js
// verify(); copied from anchor_reward_derive.test.js since production code exports none of
// this for tests.
function makeKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const pubkey = spki.subarray(spki.length - 32).toString('hex');
    return { pubkey, privateKey };
}
function sign(privateKey, msg) {
    return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex');
}

// Build a mirrored attestation row signed by `signers` over `deriveMod`'s own reward
// canonical, so verifyAttestation (run inside the swapped-in module) accepts it.
function makeRow(deriveMod, signers, overrides) {
    const row = Object.assign({
        chain: 'BTC', network: 'regtest', reward_type: 'anchor_bundle',
        round_reference: 5, snapshot_block: 5, publisher: signers[0].pubkey,
        reward_amount: '10.00000000',
        doge_anchor_txid: 'a'.repeat(64),
    }, overrides || {});
    const canonical = deriveMod.rewardCanonical(row);
    row.publisher_attestations = JSON.stringify(
        signers.map(s => ({ pubkey: s.pubkey, sig: sign(s.privateKey, canonical) })));
    return row;
}

function stubDb(validators, pending) {
    return {
        getValidatorsByCapability:  sinon.stub().resolves(validators.map(v => ({ pubkey: v.pubkey, amount: '1' }))),
        getStakeWeightsByCapability: sinon.stub().resolves(validators.map(v => ({ pubkey: v.pubkey, source: v.pubkey, weight: '1' }))),
        getPendingAnchorRewardAttestations: sinon.stub().resolves(pending || []),
        createValidatorReward:       sinon.stub().resolves(true),
        reconcileAnchorRewardWinner: sinon.stub().resolves(0),
    };
}

// A stand-in AnchorProofClient; the mint step is fully stubbed below, so its verdict is
// never consulted, only its presence (deriveAnchorRewards passes it through untouched).
function stubProof() {
    return { proveMined: sinon.stub().resolves('verified') };
}

function maturedAt(snapshotBlock) {
    return Number(snapshotBlock || 0) + ar.ANCHOR_REWARD_MIRROR_MATURITY;
}

describe('deriveAnchorRewards per-row mint loop, pinned against the mint_row wiring @regression @tier1', function () {
    const cfg = { COIN: 'BTC', NETWORK: 'regtest' };
    let deriveMod, mintStub, savedDerive, savedMintRow;

    before(function () {
        savedDerive  = require.cache[DERIVE_PATH];
        savedMintRow = require.cache[MINT_ROW_PATH];
        mintStub = sinon.stub();
        delete require.cache[DERIVE_PATH];
        require.cache[MINT_ROW_PATH] = {
            id: MINT_ROW_PATH, filename: MINT_ROW_PATH, loaded: true,
            exports: { AnchorProofUnavailableError: realMintRow.AnchorProofUnavailableError, mintProvenRow: mintStub },
        };
        deriveMod = require(DERIVE_PATH);
    });
    after(function () {
        if (savedMintRow) require.cache[MINT_ROW_PATH] = savedMintRow; else delete require.cache[MINT_ROW_PATH];
        if (savedDerive) require.cache[DERIVE_PATH] = savedDerive; else delete require.cache[DERIVE_PATH];
    });

    beforeEach(function () {
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        mintStub.reset();
    });
    afterEach(function () { sinon.restore(); });

    it('mints both logical-reward groups and reconciles each once when every mint call succeeds', async function () {
        mintStub.resolves(true);
        const keys = [makeKey()];
        const rowA = makeRow(deriveMod, keys, { round_reference: 100, snapshot_block: 100 });
        const rowB = makeRow(deriveMod, keys, { round_reference: 200, snapshot_block: 200 });
        const db = stubDb(keys, [rowA, rowB]);
        const derived = await deriveMod.deriveAnchorRewards(db, cfg, maturedAt(200), stubProof());
        assert.strictEqual(derived, 2, 'two disjoint logical-reward groups must each derive');
        assert.strictEqual(db.reconcileAnchorRewardWinner.callCount, 2);
    });

    it('derives nothing and never reconciles when every mint call fails', async function () {
        mintStub.resolves(false);
        const keys = [makeKey()];
        const rowA = makeRow(deriveMod, keys, { round_reference: 100, snapshot_block: 100 });
        const rowB = makeRow(deriveMod, keys, { round_reference: 200, snapshot_block: 200 });
        const db = stubDb(keys, [rowA, rowB]);
        const derived = await deriveMod.deriveAnchorRewards(db, cfg, maturedAt(200), stubProof());
        assert.strictEqual(derived, 0);
        assert.strictEqual(mintStub.callCount, 2, 'both logical-reward groups get a mint attempt');
        assert.ok(db.reconcileAnchorRewardWinner.notCalled);
    });

    it('counts a group once and reconciles once when its first row mints falsy and its second mints truthy', async function () {
        mintStub.onCall(0).resolves(false);
        mintStub.onCall(1).resolves(true);
        const keys = [makeKey(), makeKey()];
        const rowA = makeRow(deriveMod, keys, { publisher: keys[0].pubkey });
        const rowB = makeRow(deriveMod, keys, { publisher: keys[1].pubkey });
        const db = stubDb(keys, [rowA, rowB]);
        const derived = await deriveMod.deriveAnchorRewards(db, cfg, maturedAt(0), stubProof());
        assert.strictEqual(derived, 1, 'one logical-reward group, whichever row minted');
        assert.strictEqual(mintStub.callCount, 2, 'both publishers in the group get a mint attempt');
        assert.strictEqual(db.reconcileAnchorRewardWinner.callCount, 1);
    });

    it('passes the loop blockIndex through to the stubbed mint call for every minted row', async function () {
        mintStub.resolves(true);
        const keys = [makeKey()];
        const rowA = makeRow(deriveMod, keys, { round_reference: 100, snapshot_block: 100 });
        const rowB = makeRow(deriveMod, keys, { round_reference: 200, snapshot_block: 200 });
        const db = stubDb(keys, [rowA, rowB]);
        const blockIndex = maturedAt(200);
        await deriveMod.deriveAnchorRewards(db, cfg, blockIndex, stubProof());
        assert.strictEqual(mintStub.callCount, 2);
        for (const call of mintStub.getCalls()) assert.strictEqual(call.args[2].blockIndex, blockIndex);
    });
});

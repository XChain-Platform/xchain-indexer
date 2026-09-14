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
 * test/unit/anchor_reward_derive.test.js
 *
 * Option C: BTC-side anchor/archive reward derivation from the hub-mirrored
 * anchor_reward_attestations rows. Covers XANCPUB re-verification (accept valid, reject
 * forged / insufficient / non-member publisher), the derived reward shape (type/round/
 * amount/block_index=snapshot_block, upsert + winner-reconcile), the failover double-
 * publish collapse, and the gate-off / non-BTC no-op paths.
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const derive = require('../../src/consensus/anchor_reward_derive.js');
const swq    = require('../../src/stake_weighted_quorum.js');
const ar     = require('../../src/anchor_reward_activation.js');

// Ed25519 keypair whose raw 32-byte pubkey / 64-byte sig hex match src/consensus/ed25519.js verify().
function makeKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const pubkey = spki.subarray(spki.length - 32).toString('hex');
    return { pubkey, privateKey };
}
function sign(privateKey, msg) {
    return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex');
}

// Build a mirrored attestation row for a per-chain (v4/v5) reward, signed by `signers`
// over the module's own reward canonical (so a correctly-built quorum verifies).
function makeRow(signers, overrides) {
    const row = Object.assign({
        chain: 'BTC', network: 'regtest', reward_type: 'anchor_BTC',
        round_reference: 5, snapshot_block: 0, publisher: signers[0].pubkey,
        reward_amount: '10.00000000',
        // Every row the hub writes at/above the derive gate carries the MINED DOGE anchor
        // it is proof-bound to; the derive pass re-proves it before paying.
        doge_anchor_txid: 'a'.repeat(64),
    }, overrides || {});
    const canonical = derive.rewardCanonical(row);
    row.publisher_attestations = JSON.stringify(
        signers.map(s => ({ pubkey: s.pubkey, sig: sign(s.privateKey, canonical) })));
    return row;
}

// A stand-in AnchorProofClient. `verdict` is what the DOGE re-proof returns; the default
// is the happy path (the anchor is on DOGE, bound to this tuple, buried).
function stubProof(verdict) {
    return { proveMined: sinon.stub().resolves(verdict === undefined ? 'verified' : verdict) };
}

// Any BTC height at/after a row's maturity boundary. Derivation is keyed on the
// fleet-agreed watermark (snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY), never on
// snapshot_block itself, so a test that means "this has matured" has to say so.
function maturedAt(snapshotBlock) {
    return Number(snapshotBlock || 0) + ar.ANCHOR_REWARD_MIRROR_MATURITY;
}

function stubDb(validators, pending) {
    return {
        getValidatorsByCapability:  sinon.stub().resolves(validators.map(v => ({ pubkey: v.pubkey, amount: '1' }))),
        getStakeWeightsByCapability: sinon.stub().resolves(validators.map(v => ({ pubkey: v.pubkey, source: v.pubkey, weight: '1' }))),
        getPendingAnchorRewardAttestations: sinon.stub().resolves(pending || []),
        createValidatorReward:       sinon.stub().resolves(true),
        reconcileAnchorRewardWinner: sinon.stub().resolves(0),
    };
};;

describe('anchor_reward_derive (BTC-side derivation) @regression @tier2', () => {
    let swqStub;
    beforeEach(function () { swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false); });
    afterEach(function () { sinon.restore(); });
    ;

    describe('verifyAttestation', function () {
    it('accepts a valid 2f+1 count quorum with the publisher in the oracle_publish set', async function () {
    const keys = [makeKey(), makeKey(), makeKey(), makeKey()];        // N=4 -> 2f+1 = 3
    const row  = makeRow(keys.slice(0, 3));                           // 3 valid sigs, publisher = keys[0]
    const db   = stubDb(keys);
    assert.strictEqual(await derive.verifyAttestation(db, row), true);
    });

    it('rejects an insufficient quorum (below 2f+1)', async function () {
    const keys = [makeKey(), makeKey(), makeKey(), makeKey()];        // needs 3
    const row  = makeRow(keys.slice(0, 2));                           // only 2 valid sigs
    assert.strictEqual(await derive.verifyAttestation(stubDb(keys), row), false);
    });

    it('rejects a forged signature (does not verify over the canonical)', async function () {
    const keys = [makeKey(), makeKey(), makeKey(), makeKey()];
    const row  = makeRow(keys.slice(0, 3));
    const bad  = JSON.parse(row.publisher_attestations);
    bad[0].sig = sign(keys[0].privateKey, 'a different message entirely');   // forged
    row.publisher_attestations = JSON.stringify(bad);
    assert.strictEqual(await derive.verifyAttestation(stubDb(keys), row), false);   // 2 valid < 3
    });

    it('rejects when the publisher is not a member of the oracle_publish set', async function () {
    const keys = [makeKey(), makeKey(), makeKey(), makeKey()];
    const outsider = makeKey();
    const row  = makeRow(keys.slice(0, 3), { publisher: outsider.pubkey });
    assert.strictEqual(await derive.verifyAttestation(stubDb(keys), row), false);
    });

    it('rejects when no local oracle_publish snapshot exists yet', async function () {
    const keys = [makeKey()];
    const row  = makeRow(keys);
    assert.strictEqual(await derive.verifyAttestation(stubDb([]), row), false);
    });
    });
});

describe('anchor_reward_derive (BTC-side derivation) @regression @tier2', () => {
    let swqStub;
    beforeEach(function () { swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false); });
    afterEach(function () { sinon.restore(); });
    ;

    describe('deriveAnchorRewards', () => {
    const cfg = { COIN: 'BTC', NETWORK: 'regtest' };

    it('materializes the reward at block_index = snapshot_block with the FROZEN amount, then reconciles', async function () {
    const keys = [makeKey()];                                          // N=1 -> quorum 1
    const row  = makeRow(keys, { round_reference: 7, snapshot_block: 0 });
    const db   = stubDb(keys, [row]);
    const n    = await derive.deriveAnchorRewards(db, cfg, 200, stubProof());
    assert.strictEqual(n, 1);
    assert.ok(db.createValidatorReward.calledOnce);
    // The trailing 0 is round_qualifier: the per-chain legs are never qualified, since
    // their round_reference is CHECKPOINT_SEQ, a height that only advances.
    assert.deepStrictEqual(db.createValidatorReward.firstCall.args,
    [keys[0].pubkey, 7, 'anchor_BTC', ar.ANCHOR_REWARD_AMOUNT, 0, true, 200, 0]);
    assert.ok(db.reconcileAnchorRewardWinner.calledOnceWith(7, 'anchor_BTC', 200, null, 0));
    });

    it('keys maturity on the fleet-agreed watermark, not on snapshot_block', async function () {
    const keys = [makeKey()];
    const db   = stubDb(keys, []);
    await derive.deriveAnchorRewards(db, cfg, 5000, stubProof());
    assert.deepStrictEqual(db.getPendingAnchorRewardAttestations.firstCall.args,
    ['regtest', 5000 - ar.ANCHOR_REWARD_MIRROR_MATURITY]);
    });
    it('derives nothing before the maturity watermark can be reached at all', async function () {
    const keys = [makeKey()];
    const db   = stubDb(keys, [makeRow(keys)]);
    const n    = await derive.deriveAnchorRewards(db, cfg, ar.ANCHOR_REWARD_MIRROR_MATURITY - 1, stubProof());
    assert.strictEqual(n, 0);
    assert.ok(db.getPendingAnchorRewardAttestations.notCalled,
    'an early chain must not underflow into maturing every row at a negative height');
    });
    it('stamps the CURRENT BTC block as the materialization block, distinct from the earn-block', async function () {
    const keys = [makeKey()];
    const row  = makeRow(keys, { round_reference: 11, snapshot_block: 0 });
    const db   = stubDb(keys, [row]);
    await db.createValidatorReward.resetHistory();
    await derive.deriveAnchorRewards(db, cfg, 4321, stubProof());
    const args = db.createValidatorReward.firstCall.args;
    assert.strictEqual(args[4], 0,    'block_index stays the earn-block (snapshot_block)');
    assert.strictEqual(args[6], 4321, 'derive_block_index is the BTC block that created the row');
    assert.notStrictEqual(args[4], args[6],
    'the two heights must be persisted separately or rollback cannot scope on the creating block');
    });
    it('uses the ARCHIVE frozen amount + anchor_archive type for a v6 row', async function () {
    const keys = [makeKey()];
    const row  = makeRow(keys, { reward_type: 'anchor_archive', round_reference: 3 });
    const db   = stubDb(keys, [row]);
    await derive.deriveAnchorRewards(db, cfg, 200, stubProof());
    assert.deepStrictEqual(db.createValidatorReward.firstCall.args,
    [keys[0].pubkey, 3, 'anchor_archive', ar.ARCHIVE_REWARD_AMOUNT, 0, true, 200, 0]);
    });
    });
});

describe('anchor_reward_derive (BTC-side derivation) @regression @tier2', () => {
    let swqStub;
    beforeEach(function () { swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false); });
    afterEach(function () { sinon.restore(); });
    ;

    describe('deriveAnchorRewards', () => {
    const cfg = { COIN: 'BTC', NETWORK: 'regtest' };

    it('derives ONE anchor_bundle reward per bundle, at the ANCHOR amount, qualifier 0', async function () {
    // ANCHOR v7 writes exactly one attestation row per bundle, whatever its section
    // count, so the derive pass must produce exactly one reward and one reconcile.
    // round_reference IS the snapshot block, a height that only advances, so unlike
    // the archive leg the qualifier stays 0.
    const keys = [makeKey()];
    const row  = makeRow(keys, { reward_type: 'anchor_bundle', round_reference: 8100, snapshot_block: 8100 });
    const db   = stubDb(keys, [row]);
    const derived = await derive.deriveAnchorRewards(db, cfg, maturedAt(8100), stubProof());
    assert.strictEqual(derived, 1, 'one bundle, one derived reward group');
    assert.ok(db.createValidatorReward.calledOnce, 'never one reward per section');
    assert.deepStrictEqual(db.createValidatorReward.firstCall.args,
    [keys[0].pubkey, 8100, 'anchor_bundle', ar.ANCHOR_REWARD_AMOUNT, 8100, true, maturedAt(8100), 0]);
    assert.strictEqual(db.reconcileAnchorRewardWinner.firstCall.args[4], 0,
    'a bundle round_reference only advances, so it needs no snapshot qualifier');
    });

    it('qualifies an archive reward by its snapshot_block, in the write AND the reconcile', async function () {
    const keys = [makeKey()];
    const row  = makeRow(keys, { reward_type: 'anchor_archive', round_reference: 3, snapshot_block: 8100 });
    const db   = stubDb(keys, [row]);
    await derive.deriveAnchorRewards(db, cfg, 8100 + ar.ANCHOR_REWARD_MIRROR_MATURITY, stubProof());
    const args = db.createValidatorReward.firstCall.args;
    assert.strictEqual(args[7], 8100, 'round_qualifier must be the archive reward snapshot_block');
    assert.strictEqual(db.reconcileAnchorRewardWinner.firstCall.args[4], 8100,
    'the reconcile must collapse only within that snapshot, not across the reissued seq');
    });
    it('groups two archive rewards sharing a reissued seq SEPARATELY, one reconcile each', async function () {
    const keys = [makeKey()];
    const rowA = makeRow(keys, { reward_type: 'anchor_archive', round_reference: 3, snapshot_block: 8100 });
    const rowB = makeRow(keys, { reward_type: 'anchor_archive', round_reference: 3, snapshot_block: 9200 });
    const db   = stubDb(keys, [rowA, rowB]);
    const n    = await derive.deriveAnchorRewards(db, cfg, 9200 + ar.ANCHOR_REWARD_MIRROR_MATURITY, stubProof());
    assert.strictEqual(n, 2, 'both archive rewards derive');
    assert.strictEqual(db.reconcileAnchorRewardWinner.callCount, 2, 'one reconcile per snapshot');
    assert.deepStrictEqual(
    db.reconcileAnchorRewardWinner.getCalls().map(c => c.args[4]).sort((a, b) => a - b),
    [8100, 9200]);
    });
    it('collapses a failover double-publish: both publishers inserted, ONE reconcile per round', async function () {
    const keys = [makeKey(), makeKey()];
    const rowA = makeRow(keys, { publisher: keys[0].pubkey });
    const rowB = makeRow(keys, { publisher: keys[1].pubkey });
    const db   = stubDb(keys, [rowA, rowB]);
    const n    = await derive.deriveAnchorRewards(db, cfg, maturedAt(0), stubProof());
    assert.strictEqual(n, 1, 'one logical reward group');
    assert.strictEqual(db.createValidatorReward.callCount, 2, 'both publishers upserted before reconcile');
    assert.strictEqual(db.reconcileAnchorRewardWinner.callCount, 1);
    });
    });
});

describe('anchor_reward_derive (BTC-side derivation) @regression @tier2', () => {
    let swqStub;
    beforeEach(function () { swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false); });
    afterEach(function () { sinon.restore(); });
    ;

    describe('deriveAnchorRewards', () => {
    const cfg = { COIN: 'BTC', NETWORK: 'regtest' };

    it('is a no-op on a non-BTC chain (reward resolves only where the stake lives)', async function () {
    const keys = [makeKey()];
    const db   = stubDb(keys, [makeRow(keys)]);
    const n    = await derive.deriveAnchorRewards(db, { COIN: 'DOGE', NETWORK: 'regtest' }, 1000, stubProof());
    assert.strictEqual(n, 0);
    assert.ok(db.getPendingAnchorRewardAttestations.notCalled);
    assert.ok(db.createValidatorReward.notCalled);
    });

    it('is a no-op below the derive-relocation flag-day', async function () {
    // Every shipped network arms at genesis (mainnet by the 2026-09-09 ruling), so
    // the below-the-gate path is driven by pinning a real height on mainnet for the
    // case and restoring the shipped 0. The subject is that the DOGE-side legacy
    // path stays byte-identical below the height, not which network is armed.
    const shipped = ar.ANCHOR_REWARD_DERIVE_ACTIVATION.mainnet;
    ar.ANCHOR_REWARD_DERIVE_ACTIVATION.mainnet = 2000000;
    try {
    const keys = [makeKey()];
    const row  = makeRow(keys, { network: 'mainnet', snapshot_block: 1000000 });
    const db   = stubDb(keys, [row]);
    const n    = await derive.deriveAnchorRewards(db, { COIN: 'BTC', NETWORK: 'mainnet' }, maturedAt(1000000), stubProof());
    assert.strictEqual(n, 0, 'a snapshot below the derive height must not relocate');
    assert.ok(db.createValidatorReward.notCalled);
    } finally { ar.ANCHOR_REWARD_DERIVE_ACTIVATION.mainnet = shipped; }
    });

    it('derives on a genesis-armed mainnet, by the 2026-09-09 ruling', async function () {
    // 0 anchor reward attestations and 0 validator_rewards rows on any mainnet
    // chain (measured 2026-09-09), so relocating the derive reinterprets nothing.
    assert.strictEqual(ar.ANCHOR_REWARD_DERIVE_ACTIVATION.mainnet, 0);
    const keys = [makeKey()];
    const row  = makeRow(keys, { network: 'mainnet', snapshot_block: 1000000 });
    const db   = stubDb(keys, [row]);
    const n    = await derive.deriveAnchorRewards(db, { COIN: 'BTC', NETWORK: 'mainnet' }, maturedAt(1000000), stubProof());
    assert.strictEqual(n, 1, 'the relocated derive must run on mainnet from block 0');
    assert.ok(db.createValidatorReward.called);
    });
    });
});

describe('anchor-reward derive set is INVARIANT under the barrier change @regression @tier1', () => {
    const cfg = { COIN: 'BTC', NETWORK: 'regtest' };
    const MODULES = [
    '../../src/mirror_admission_activation.js',
    '../../src/anchor_reward_activation.js',
    '../../src/consensus/anchor_reward_derive.js'
    ];
    beforeEach(function () { sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false); });
    afterEach(function () { sinon.restore(); });
    async function runFixture(deriveMod, keys, row) {
    const db = stubDb(keys, [row]);
    const minted = await deriveMod.deriveAnchorRewards(db, cfg, maturedAt(0), stubProof());
    return {
    minted: minted,
    pendingArgs: db.getPendingAnchorRewardAttestations.args,
    rewardArgs:  db.createValidatorReward.args,
    maturity:    deriveMod.ANCHOR_REWARD_MIRROR_MATURITY
    };
    }
    function withArmedActivation(fn) {
    const paths    = MODULES.map(m => require.resolve(m));
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = '0';
    try {
    return fn(require('../../src/consensus/anchor_reward_derive.js'),
    require('../../src/anchor_reward_activation.js'));
    } finally {
    for (const [p, mod] of saved) {
    if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
    }
    if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
    }

    it('derives the identical set, at the identical height, armed or inert', async function () {
    const keys = [makeKey()];
    const row  = makeRow(keys, { round_reference: 11, snapshot_block: 0 });

    const inert = await runFixture(derive, keys, row);
    const armed = await withArmedActivation(async (armedDerive, armedAct) => {
    // The arming is real, or the comparison below proves nothing.
    assert.strictEqual(armedAct.isAnchorAttestBarrierHorizonActive('regtest', 1000), true);
    assert.strictEqual(require('../../src/anchor_reward_activation.js')
    .ANCHOR_ATTEST_BARRIER_ACTIVATION.regtest, 0);
    return runFixture(armedDerive, keys, row);
    });

    assert.strictEqual(armed.maturity, inert.maturity, 'the maturity constant must not move');
    assert.deepStrictEqual(armed.pendingArgs, inert.pendingArgs,
    'the derive pass must read the same (network, watermark) at the same block');
    assert.deepStrictEqual(armed.rewardArgs, inert.rewardArgs,
    'and mint the same reward, for the same round, at the same block_index');
    assert.strictEqual(armed.minted, inert.minted);
    assert.strictEqual(inert.minted, 1, 'the fixture must actually mint, or this compares two zeroes');
    });
});

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
 **********************************************************************
 * test/unit/anchor/anchor_reward_derive.test/anchor_reward_derive_btc_side.test.js
 *
 * Sibling block of the anchor_reward_derive.test.js suite, carrying:
 *   anchor_reward_derive (BTC-side derivation) @regression @tier2
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const derive = require('../../../../src/consensus/anchor_reward_derive.js');
const swq    = require('../../../../src/consensus/stake_weighted_quorum.js');
const ar     = require('../../../../src/consensus/gates/anchor_reward_gate.js');


function makeKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const pubkey = spki.subarray(spki.length - 32).toString('hex');
    return { pubkey, privateKey };
}
function sign(privateKey, msg) {
    return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex');
}



function makeRow(signers, overrides) {
    const row = Object.assign({
        chain: 'BTC', network: 'regtest', reward_type: 'anchor_BTC',
        round_reference: 5, snapshot_block: 0, publisher: signers[0].pubkey,
        reward_amount: '10.00000000',


        doge_anchor_txid: 'a'.repeat(64),
    }, overrides || {});
    const canonical = derive.rewardCanonical(row);
    row.publisher_attestations = JSON.stringify(
        signers.map(s => ({ pubkey: s.pubkey, sig: sign(s.privateKey, canonical) })));
    return row;
}



function stubProof(verdict) {
    return { proveMined: sinon.stub().resolves(verdict === undefined ? 'verified' : verdict) };
}




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

    describe('deriveAnchorRewards', () => {
    const cfg = { COIN: 'BTC', NETWORK: 'regtest' };

    describe('reward-family flag-days', function () {

    // Threshold-exact on both sides, because a gate that is only ever driven from
    // below is how an over-broad predicate suppresses legitimate pay with nothing
    // going red.
    const cases = [
    { type: 'anchor_BTC',     gate: 'ANCHOR_REWARD_ACTIVATION'  },
    { type: 'anchor_bundle',  gate: 'ANCHOR_REWARD_ACTIVATION'  },
    { type: 'anchor_archive', gate: 'ARCHIVE_REWARD_ACTIVATION' },
    ];

    for (const c of cases) {
    const flagDay = ar[c.gate].mainnet;
    it('mints no ' + c.type + ' below ' + c.gate + ' even on a full quorum', async function () {
    const keys = [makeKey()];
    const row  = makeRow(keys, { network: 'mainnet', reward_type: c.type,
    snapshot_block: flagDay - 1 });
    const db   = stubDb(keys, [row]);
    const n    = await derive.deriveAnchorRewards(
    db, { COIN: 'BTC', NETWORK: 'mainnet' }, maturedAt(flagDay - 1), stubProof());
    assert.strictEqual(n, 0, 'a snapshot below the family flag-day must pay nothing');
    assert.ok(db.createValidatorReward.notCalled,
    'no validator_rewards row may exist below the family flag-day');
    });
    it('mints ' + c.type + ' at exactly ' + c.gate, async function () {
    const keys = [makeKey()];
    const row  = makeRow(keys, { network: 'mainnet', reward_type: c.type,
    snapshot_block: flagDay });
    const db   = stubDb(keys, [row]);
    const n    = await derive.deriveAnchorRewards(
    db, { COIN: 'BTC', NETWORK: 'mainnet' }, maturedAt(flagDay), stubProof());
    assert.strictEqual(n, 1, 'the threshold block itself is ON, not off-by-one');
    assert.ok(db.createValidatorReward.calledOnce);
    });
    }
    it('pays a reward type it has never seen rather than failing it closed', async function () {
    // A whitelist of known types would silently stop paying a family added later.
    // Anything that is not anchor_archive rides the anchor flag-day, which is the
    // same split the amount pick makes.
    const keys = [makeKey()];
    const row  = makeRow(keys, { network: 'mainnet', reward_type: 'anchor_FUTURECHAIN',
    snapshot_block: ar.ANCHOR_REWARD_ACTIVATION.mainnet });
    const db   = stubDb(keys, [row]);
    const n    = await derive.deriveAnchorRewards(
    db, { COIN: 'BTC', NETWORK: 'mainnet' },
    maturedAt(ar.ANCHOR_REWARD_ACTIVATION.mainnet), stubProof());
    assert.strictEqual(n, 1);
    });
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

    it('derives nothing when no rows are pending (idempotent steady state)', async function () {
    const db = stubDb([makeKey()], []);
    assert.strictEqual(await derive.deriveAnchorRewards(db, cfg, 1000, stubProof()), 0);
    assert.ok(db.createValidatorReward.notCalled);
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
    describe('DOGE mined-anchor re-proof', function () {
    it('binds the proof to the reward tuple it is about to pay', async function () {
    const keys  = [makeKey()];
    const row   = makeRow(keys, { round_reference: 9, snapshot_block: 0 });
    const db    = stubDb(keys, [row]);
    const proof = stubProof();
    await derive.deriveAnchorRewards(db, cfg, maturedAt(0), proof);
    const asked = proof.proveMined.firstCall.args[0];
    assert.strictEqual(asked.txid, row.doge_anchor_txid);
    assert.strictEqual(asked.rewardType, 'anchor_BTC');
    assert.strictEqual(asked.roundReference, 9);
    assert.strictEqual(asked.snapshotBlock, 0);
    assert.strictEqual(asked.publisher, keys[0].pubkey.toLowerCase());
    assert.ok(asked.minConfirmations > 0, 'a depth requirement must be stated, never defaulted to zero');
    });
    // The mint gate's burial depth is a LEDGER input: it decides the BTC height at
    // which a reward materializes, so every node must apply the identical number.
    // It therefore comes from the frozen constant beside the activation map, never
    // from coins.resolveConfirmations / coins.DEFAULT_CONFIRMATIONS: the registry
    // classifies `confirmations` as operator-tunable depth, leaves it out of the
    // pinned consensus subset, and lets XCHAIN_CONFIRMATIONS_DOGE move it per node.
    // This case goes red the moment someone wires the registry knob back in.
    it('takes the depth from the frozen ledger constant, not the operator knob', async function () {
    const saved = process.env.XCHAIN_CONFIRMATIONS_DOGE;
    process.env.XCHAIN_CONFIRMATIONS_DOGE = '2';
    try {
    const keys  = [makeKey()];
    const db    = stubDb(keys, [makeRow(keys, { snapshot_block: 0 })]);
    const proof = stubProof();
    await derive.deriveAnchorRewards(db, cfg, maturedAt(0), proof);
    assert.strictEqual(proof.proveMined.firstCall.args[0].minConfirmations,
    ar.ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS,
    'the mint gate must state the frozen depth, unmoved by the env override');
    } finally {
    if(saved === undefined) delete process.env.XCHAIN_CONFIRMATIONS_DOGE;
    else process.env.XCHAIN_CONFIRMATIONS_DOGE = saved;
    }
    });
    // Drift alarm. The frozen ledger depth and the registry's DOGE default are two
    // numbers with two owners that must agree at rest: the hub attests at the
    // registry value (floor-clamped to it on mainnet and testnet) and this gate
    // mints at the frozen one, so a silent retune of coins/DOGE.js would let a hub
    // attest shallower than the fleet will ever mint and stall block processing.
    // Parting them is a deliberate flag-day act, and this case makes it loud.
    it('the frozen depth still matches the coin registry default (drift alarm)', function () {
    const coins = require('../../../../src/coins');
    assert.strictEqual(ar.ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS, coins.DEFAULT_CONFIRMATIONS.DOGE,
    'anchor-reward mint depth and coins/DOGE.js confirmations have drifted; ' +
    'moving either is a flag-day change that must move both');
    });
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

    describe('DOGE mined-anchor re-proof', function () {
    it('DEFERS the block (throws) when the anchor cannot be proven either way', async function () {
    const keys = [makeKey()];
    const db   = stubDb(keys, [makeRow(keys)]);
    await assert.rejects(
    () => derive.deriveAnchorRewards(db, cfg, maturedAt(0), stubProof('unknown')),
    (e) => e instanceof derive.AnchorProofUnavailableError);
    assert.ok(db.createValidatorReward.notCalled, 'nothing is minted on an unprovable anchor');
    });

    it('DEFERS the block when no DOGE visibility is wired at all', async function () {
    const keys = [makeKey()];
    const db   = stubDb(keys, [makeRow(keys)]);
    await assert.rejects(
    () => derive.deriveAnchorRewards(db, cfg, maturedAt(0), null),
    (e) => e instanceof derive.AnchorProofUnavailableError);
    assert.ok(db.createValidatorReward.notCalled);
    });

    // A positively-contradicted txid is chain data, identical on every node, so
    // skipping it is deterministic; deferring on it would wedge the fleet forever.
    it('SKIPS a row whose anchor proof is positively rejected, without deferring', async function () {
    const keys = [makeKey()];
    const db   = stubDb(keys, [makeRow(keys)]);
    const n    = await derive.deriveAnchorRewards(db, cfg, maturedAt(0), stubProof('rejected'));
    assert.strictEqual(n, 0);
    assert.ok(db.createValidatorReward.notCalled);
    assert.ok(db.reconcileAnchorRewardWinner.notCalled);
    });
    });
    });
});

// ── The derive-set identity fixture ──
//
// The anchor-attest barrier gained a maturity-horizon bound and, above the mirror-admission
// activation, a height-keyed release rule. Both are node-local WAIT decisions: they change
// WHEN a node reaches a block, never WHICH rows it derives once it is there. That is the
// property the whole barrier change rests on, and it is the one a unit case can pin
// exactly, so it is pinned here rather than asserted in a comment.
//
// It is driven by running the identical fixture twice, once with the barrier's activation
// INERT and once ARMED through the shared regtest env seam, and comparing the derive pass's
// reads and writes argument for argument. Arming genuinely reaches this module's graph (the
// activation map's regtest slot resolves through the same resolver at require time), so a
// constant moved or a maturity re-keyed by that arming would show up here as a diff.


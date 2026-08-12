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
 * test/unit/anchorRewardDerive.test.js
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

const derive = require('../../src/anchor_reward_derive.js');
const swq    = require('../../src/stake_weighted_quorum.js');
const ar     = require('../../src/anchor_reward_activation.js');

// Ed25519 keypair whose raw 32-byte pubkey / 64-byte sig hex match src/ed25519.js verify().
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
    }, overrides || {});
    const canonical = derive.rewardCanonical(row);
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

describe('anchor_reward_derive (BTC-side derivation) @regression @tier2', function () {
    let swqStub;
    beforeEach(function () { swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false); });
    afterEach(function () { sinon.restore(); });

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

    describe('deriveAnchorRewards', function () {
        const cfg = { COIN: 'BTC', NETWORK: 'regtest' };

        it('materializes the reward at block_index = snapshot_block with the FROZEN amount, then reconciles', async function () {
            const keys = [makeKey()];                                          // N=1 -> quorum 1
            const row  = makeRow(keys, { round_reference: 7, snapshot_block: 0 });
            const db   = stubDb(keys, [row]);
            const n    = await derive.deriveAnchorRewards(db, cfg, 100);
            assert.strictEqual(n, 1);
            assert.ok(db.createValidatorReward.calledOnce);
            assert.deepStrictEqual(db.createValidatorReward.firstCall.args,
                [keys[0].pubkey, 7, 'anchor_BTC', ar.ANCHOR_REWARD_AMOUNT, 0, true, 100]);
            assert.ok(db.reconcileAnchorRewardWinner.calledOnceWith(7, 'anchor_BTC', 100, null));
        });

        // The reward is EARNED at snapshot_block but MATERIALIZED at the
        // BTC block being processed, and rollback deletes on block_index, so without the second
        // stamp a reorg to any height in (snapshot_block, blockIndex] orphans the block that
        // minted the row yet leaves it spendable, forking the COLLECT rail against a replay.
        it('stamps the CURRENT BTC block as the materialization block, distinct from the earn-block', async function () {
            const keys = [makeKey()];
            const row  = makeRow(keys, { round_reference: 11, snapshot_block: 0 });
            const db   = stubDb(keys, [row]);
            await db.createValidatorReward.resetHistory();
            await derive.deriveAnchorRewards(db, cfg, 4321);
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
            await derive.deriveAnchorRewards(db, cfg, 200);
            assert.deepStrictEqual(db.createValidatorReward.firstCall.args,
                [keys[0].pubkey, 3, 'anchor_archive', ar.ARCHIVE_REWARD_AMOUNT, 0, true, 200]);
        });

        it('collapses a failover double-publish: both publishers inserted, ONE reconcile per round', async function () {
            const keys = [makeKey(), makeKey()];
            const rowA = makeRow(keys, { publisher: keys[0].pubkey });
            const rowB = makeRow(keys, { publisher: keys[1].pubkey });
            const db   = stubDb(keys, [rowA, rowB]);
            const n    = await derive.deriveAnchorRewards(db, cfg, 50);
            assert.strictEqual(n, 1, 'one logical reward group');
            assert.strictEqual(db.createValidatorReward.callCount, 2, 'both publishers upserted before reconcile');
            assert.strictEqual(db.reconcileAnchorRewardWinner.callCount, 1);
        });

        it('is a no-op on a non-BTC chain (reward resolves only where the stake lives)', async function () {
            const keys = [makeKey()];
            const db   = stubDb(keys, [makeRow(keys)]);
            const n    = await derive.deriveAnchorRewards(db, { COIN: 'DOGE', NETWORK: 'regtest' }, 100);
            assert.strictEqual(n, 0);
            assert.ok(db.getPendingAnchorRewardAttestations.notCalled);
            assert.ok(db.createValidatorReward.notCalled);
        });

        it('is a no-op below the derive-relocation flag-day (inert placeholder network)', async function () {
            const keys = [makeKey()];
            const row  = makeRow(keys, { network: 'mainnet', snapshot_block: 1000000 });
            const db   = stubDb(keys, [row]);
            const n    = await derive.deriveAnchorRewards(db, { COIN: 'BTC', NETWORK: 'mainnet' }, 1000000);
            assert.strictEqual(n, 0, 'mainnet derive gate is an inert null placeholder');
            assert.ok(db.createValidatorReward.notCalled);
        });

        it('derives nothing when no rows are pending (idempotent steady state)', async function () {
            const db = stubDb([makeKey()], []);
            assert.strictEqual(await derive.deriveAnchorRewards(db, cfg, 100), 0);
            assert.ok(db.createValidatorReward.notCalled);
        });
    });
});

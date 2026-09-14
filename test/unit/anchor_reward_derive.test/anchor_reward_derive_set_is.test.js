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
 * test/unit/anchor_reward_derive.test/anchor_reward_derive_set_is.test.js
 *
 * Sibling block of the anchor_reward_derive.test.js suite, carrying:
 *   anchor-reward derive set is INVARIANT under the barrier change @regression @tier1
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const derive = require('../../../src/consensus/anchor_reward_derive.js');
const swq    = require('../../../src/stake_weighted_quorum.js');
const ar     = require('../../../src/anchor_reward_activation.js');


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

describe('anchor-reward derive set is INVARIANT under the barrier change @regression @tier1', () => {
    const cfg = { COIN: 'BTC', NETWORK: 'regtest' };
    const MODULES = [
    '../../../src/mirror_admission_activation.js',
    '../../../src/anchor_reward_activation.js',
    '../../../src/consensus/anchor_reward_derive.js'
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
    return fn(require('../../../src/consensus/anchor_reward_derive.js'),
    require('../../../src/anchor_reward_activation.js'));
    } finally {
    for (const [p, mod] of saved) {
    if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
    }
    if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
    }

    it('the inert maps really are inert, so today\'s fleet sees no change at all', function () {
    assert.strictEqual(ar.ANCHOR_ATTEST_BARRIER_ACTIVATION.mainnet, null);
    assert.strictEqual(ar.ANCHOR_ATTEST_BARRIER_ACTIVATION.testnet, null);
    assert.strictEqual(ar.isAnchorAttestBarrierHorizonActive('mainnet', 10 ** 9), false);
    assert.strictEqual(ar.isAnchorAttestBarrierHorizonActive('testnet', 10 ** 9), false);
    assert.strictEqual(ar.isAnchorAttestBarrierHorizonActive('regtest', 10 ** 9), false,
    'inert by default: the regtest slot arms only through its env seam');
    });
});

// Maturity rule: snapshot_block is the height the XANCPUB signing set was

// resolved at, and it is already in the past when the row is written, so maturing on it

// let two nodes with different mirror contents derive the same reward at different

// heights. Maturity is now the fleet-agreed watermark, and the fetch must ask for it.

// The reward is EARNED at snapshot_block but MATERIALIZED at the

// BTC block being processed, and rollback deletes on block_index, so without the second

// stamp a reorg to any height in (snapshot_block, blockIndex] orphans the block that

// minted the row yet leaves it spendable, forking the COLLECT rail against a replay.

// The archive leg's round_reference is MATCH_BATCH_SEQ, a dense counter the hub

// allocates from its own tables, and a wipe-and-replay rebase resets those tables - so

// the same seq can name two genuinely distinct archive anchors. snapshot_block is what

// the signed XANCPUB tuple already uses to tell them apart, and it has to reach the

// ledger key (round_qualifier) and the reconcile, or the second real reward is either

// never inserted or deleted as a "loser" of the first one's round.

// Two archive anchors sharing a reissued seq are TWO logical rewards, so they must not

// land in one reconcile group: one group means one surviving winner, and the other

// publisher - quorum-attested, on a different snapshot - is paid nothing.

// The reward FAMILY flag-days, which are a different question from the relocation

// flag-day above. ANCHOR_REWARD_DERIVE_ACTIVATION only moves the mint to this

// indexer; ANCHOR_REWARD_ACTIVATION / ARCHIVE_REWARD_ACTIVATION decide whether the

// family pays at all, and the protocol says a below-flag-day archive anchor indexes

// valid but "never derives an anchor_archive reward even with a full attestation".

// The relocation gate is armed at genesis everywhere, so it cannot stand in for these.

// The mined-anchor re-proof. The mirror is transport: the hub that wrote

// the row is the party the reward pays, so its claim that the anchor was mined is

// re-checked here against DOGE before any money row exists.

// Run the fixture against one instance of the derive module and return everything it

// read and wrote, as plain data.

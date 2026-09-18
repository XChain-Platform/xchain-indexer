/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * ANCHOR reward settlement: the DOGE-side validator reward an attested
 * archive head or bundle earns below the derive-relocation flag day. ANCHOR
 * has no other ledger effect. Whether the attestation quorum is met is
 * decided in quorum.js; this file only writes (or skips) the reward.
 *
 ********************************************************************/

const ar    = require('../../consensus/gates/anchor_reward_gate.js');
const arKey = require('./anchor_reward_key.js');

const { getLogger } = require('../../observability/index.js');

// Archive leg (v1): reward type anchor_archive, round = MATCH_BATCH_SEQ.
async function creditArchiveReward(handler, data, attQuorumMet, snapPubkeys, format){
    if(ar.isAnchorRewardDeriveActive(Number(data['SNAPSHOT_BLOCK']), data['NETWORK'])){
        // At/above the derive-relocation flag-day, the reward is materialized by the
        // BTC indexer from the mirrored anchor_reward_attestations row (where the stake
        // source resolves; ANCHOR is DOGE-only, capability staking is BTC-only). This
        // DOGE-side write always silently dropped (no local stake), so stopping it is
        // byte-neutral to the DOGE ledger and removes the wasted lookup. The
        // attestation-quorum check above still runs (anchor validity is unaffected);
        // only the createValidatorReward/reconcile write is relocated.
    } else if(attQuorumMet && snapPubkeys.has(String(data['PUBLISHER']))){
        let rewardType  = 'anchor_archive';
        let rewardRound = Number(data['MATCH_BATCH_SEQ']);
        let rewardAmt   = ar.ARCHIVE_REWARD_AMOUNT;
        // The archive leg's rewardRound is MATCH_BATCH_SEQ, the dense hub counter the
        // replay-guard comment in archive_head.js describes as restarting across a wipe-and-replay
        // rebase, so it alone does not identify the reward: two genuinely distinct
        // archive anchors can carry a reissued seq. The qualifier is the snapshot
        // block that already distinguishes them in the SIGNED tuple (rewardCanonical
        // puts SNAPSHOT_BLOCK in the archive XANCPUB canonical), carried into the
        // ledger key so both real publishes survive the upsert and the reconcile.
        let rewardQual  = arKey.rewardRoundQualifier(rewardType, data['SNAPSHOT_BLOCK']);
        let ok = await handler.indexerDb.createValidatorReward(
            data['PUBLISHER'], rewardRound, rewardType,
            rewardAmt, Number(data['SNAPSHOT_BLOCK']), true, null, rewardQual);
        if(ok)
            await handler.indexerDb.reconcileAnchorRewardWinner(
                rewardRound, rewardType,
                Number(data['BLOCK_INDEX']), Number(data['ACTION_INDEX']), rewardQual);
    } else {
        getLogger().warn('\t ANCHOR v' + format + ' : publisher-attestation quorum not met or PUBLISHER not in oracle_publish set; reward skipped (anchor still valid)');
    }
}

// Bundle leg (v0): reward type anchor_bundle, round = the bundle SNAPSHOT_BLOCK.
async function creditBundleReward(handler, data, attQuorumMet, bundleSet){
    if(ar.isAnchorRewardDeriveActive(Number(data['SNAPSHOT_BLOCK']), data['NETWORK'])){
        // At/above the derive-relocation flag-day the reward is materialized by the
        // BTC indexer from the mirrored anchor_reward_attestations row (that is where
        // the oracle_publish stake resolves; ANCHOR is DOGE-only, staking is BTC-only).
        // This DOGE-side write always dropped silently, so skipping it is byte-neutral
        // to the DOGE ledger. The attestation quorum above still runs.
    } else if(attQuorumMet && bundleSet.snapPubkeys.has(String(data['PUBLISHER']))){
        let rewardRound = Number(data['SNAPSHOT_BLOCK']);
        // Qualifier 0: unlike the archive leg's reissuable MATCH_BATCH_SEQ, a
        // bundle's round_reference IS the snapshot block, a height that only
        // advances, so the (type, round) pair already names one logical reward.
        let rewardQual  = arKey.rewardRoundQualifier('anchor_bundle', data['SNAPSHOT_BLOCK']);
        let ok = await handler.indexerDb.createValidatorReward(
            data['PUBLISHER'], rewardRound, 'anchor_bundle',
            ar.ANCHOR_REWARD_AMOUNT, Number(data['SNAPSHOT_BLOCK']), true, null, rewardQual);
        if(ok)
            await handler.indexerDb.reconcileAnchorRewardWinner(
                rewardRound, 'anchor_bundle',
                Number(data['BLOCK_INDEX']), Number(data['ACTION_INDEX']), rewardQual);
    } else {
        getLogger().warn('\t ANCHOR v0 : publisher-attestation quorum not met or PUBLISHER not in oracle_publish set; reward skipped (bundle still valid)');
    }
}

module.exports = { creditArchiveReward, creditBundleReward };

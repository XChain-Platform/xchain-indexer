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
 * ANCHOR reward settlement. At the derive-relocation flag day the BTC indexer
 * derives the reward from the mirrored anchor_reward_attestations row, where
 * the oracle_publish stake resolves. Below the flag day, full Anchor handlers
 * retain the legacy v0 and v1 credit path. Bare settlement consumers have no
 * legacy handlers and warn without touching the reward ledger.
 *
 ********************************************************************/

const ar = require('../../consensus/gates/anchor_reward_gate.js');
const arKey = require('./anchor_reward_key.js');
const gateRegistry = require('../../consensus/gate_registry');
const { rewardTypeFor } = require('./reward_family.js');
const { getLogger } = require('../../observability/index.js');

function warnRewardSkipped(format){
    getLogger().warn('\t ANCHOR v' + format + ' : no legacy reward path applies; reward skipped');
}

async function creditLegacyArchiveReward(data, attQuorumMet, snapPubkeys, format){
    if(attQuorumMet && snapPubkeys.has(String(data['PUBLISHER']))){
        let foldActive = gateRegistry.activeAt(
            'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION',
            this.config.NETWORK, this.config.COIN, Number(data.BLOCK_INDEX), null);
        let rewardType = rewardTypeFor(format, foldActive);
        if(rewardType === null){
            getLogger().warn('\t ANCHOR v' + format + ' : archive reward is retired at the fold; reward skipped');
            return;
        }
        let rewardRound = Number(data['MATCH_BATCH_SEQ']);
        let rewardQual = arKey.rewardRoundQualifier(rewardType, data['SNAPSHOT_BLOCK']);
        let createReward = this.indexerDb.createValidatorReward.bind(this.indexerDb);
        let ok = await createReward(
            data['PUBLISHER'], rewardRound, rewardType,
            ar.ARCHIVE_REWARD_AMOUNT, Number(data['SNAPSHOT_BLOCK']), true, null, rewardQual);
        if(ok)
            await this.indexerDb.reconcileAnchorRewardWinner(
                rewardRound, rewardType,
                Number(data['BLOCK_INDEX']), Number(data['ACTION_INDEX']), rewardQual);
    } else {
        getLogger().warn('\t ANCHOR v' + format + ' : publisher-attestation quorum not met or PUBLISHER not in oracle_publish set; reward skipped (anchor still valid)');
    }
}

async function creditLegacyBundleReward(data, attQuorumMet, bundleSet){
    if(attQuorumMet && bundleSet.snapPubkeys.has(String(data['PUBLISHER']))){
        let rewardRound = Number(data['SNAPSHOT_BLOCK']);
        let rewardQual = arKey.rewardRoundQualifier('anchor_bundle', data['SNAPSHOT_BLOCK']);
        let createReward = this.indexerDb.createValidatorReward.bind(this.indexerDb);
        let ok = await createReward(
            data['PUBLISHER'], rewardRound, 'anchor_bundle',
            ar.ANCHOR_REWARD_AMOUNT, Number(data['SNAPSHOT_BLOCK']), true, null, rewardQual);
        if(ok)
            await this.indexerDb.reconcileAnchorRewardWinner(
                rewardRound, 'anchor_bundle',
                Number(data['BLOCK_INDEX']), Number(data['ACTION_INDEX']), rewardQual);
    } else {
        getLogger().warn('\t ANCHOR v0 : publisher-attestation quorum not met or PUBLISHER not in oracle_publish set; reward skipped (bundle still valid)');
    }
}

function installLegacyRewardCredits(handler){
    handler.creditLegacyArchiveReward = creditLegacyArchiveReward;
    handler.creditLegacyBundleReward = creditLegacyBundleReward;
}

async function creditArchiveReward(handler, data, attQuorumMet, snapPubkeys, format){
    if(!ar.isAnchorRewardDeriveActive(Number(data['SNAPSHOT_BLOCK']), data['NETWORK']) &&
        typeof handler.creditLegacyArchiveReward === 'function')
        return await handler.creditLegacyArchiveReward(data, attQuorumMet, snapPubkeys, format);
    warnRewardSkipped(format);
}

async function creditBundleReward(handler, data, attQuorumMet, bundleSet){
    if(!ar.isAnchorRewardDeriveActive(Number(data['SNAPSHOT_BLOCK']), data['NETWORK']) &&
        typeof handler.creditLegacyBundleReward === 'function')
        return await handler.creditLegacyBundleReward(data, attQuorumMet, bundleSet);
    warnRewardSkipped(0);
}

module.exports = {
    creditArchiveReward,
    creditBundleReward,
    installLegacyRewardCredits,
};

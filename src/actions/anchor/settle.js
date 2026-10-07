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
 * ANCHOR reward settlement. The BTC indexer derives the reward from the mirrored
 * anchor_reward_attestations row, where the oracle_publish stake resolves, so
 * the DOGE-side handlers never write the reward ledger and only log the skip.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

function warnRewardSkipped(format){
    getLogger().warn('\t ANCHOR v' + format + ' : no legacy reward path applies; reward skipped');
}

function installLegacyRewardCredits(){}

async function creditArchiveReward(handler, data, attQuorumMet, snapPubkeys, format){
    warnRewardSkipped(format);
}

async function creditBundleReward(handler, data, attQuorumMet, bundleSet){
    warnRewardSkipped(0);
}

module.exports = {
    creditArchiveReward,
    creditBundleReward,
    installLegacyRewardCredits,
};

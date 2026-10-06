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
 * ANCHOR reward settlement: the validator reward an attested archive head or
 * bundle earns is derived on the BTC indexer from the mirrored
 * anchor_reward_attestations row, where the oracle_publish stake resolves
 * (ANCHOR is DOGE-only, capability staking is BTC-only). The DOGE side writes
 * no reward; these entry points stay so the archive and bundle legs share one
 * settlement call site.
 *
 ********************************************************************/

// Archive leg (v1): no DOGE-side reward write.
async function creditArchiveReward(){}

// Bundle leg (v0): no DOGE-side reward write.
async function creditBundleReward(){}

module.exports = { creditArchiveReward, creditBundleReward };

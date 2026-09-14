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
 *
 * The logical-reward grouping deriveAnchorRewards reconciles over: which
 * mirrored attestation rows are publishers of one and the same reward.
 *
 ********************************************************************/

'use strict';

const arKey = require('../../actions/anchor/anchor_reward_key.js');

// Group by the logical reward (reward_type, round_reference, round_qualifier): every
// attesting publisher for a round must be inserted BEFORE reconcile, so a failover
// double-publish collapses to the smallest-pubkey winner (identical to the DOGE on-chain
// path anchor.js drives).
//
// The qualifier is in the key because for 'anchor_archive' the pair (reward_type,
// round_reference) does NOT name one logical reward: round_reference is MATCH_BATCH_SEQ,
// a dense hub counter a wipe-and-replay rebase reissues (anchor_reward_key.js). Two
// distinct archive anchors sharing a reissued seq landed in ONE group, so the single
// reconcile that group ran collapsed them to one winner across two snapshots and deleted
// a real publisher's pay. Split by qualifier, each snapshot's archive reward reconciles
// as its own single-winner group, which is what the attestation quorum actually attested.
//
// Returns a Map from group key to its rows, in first-seen order.
function groupByLogicalReward(rows){
    let groups = new Map();
    for(let row of rows){
        let key = row.reward_type + '|' + row.round_reference + '|' +
                  arKey.rewardRoundQualifier(row.reward_type, row.snapshot_block);
        if(!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return groups;
}

module.exports = { groupByLogicalReward };

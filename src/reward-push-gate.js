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
 * XChain Indexer - validator-reward push rail, retired
 *
 * The refusal the pushvalidatorrewards RPC now answers with, for every reward
 * type and on every network, plus the reward_type canonicalization that names
 * the type in it. Kept out of api.js so both are unit-testable as behaviour
 * rather than as handler source text.
 *
 ********************************************************************/

'use strict';

// Normalize a per-chain anchor reward_type to its canonical uppercase-suffix
// form: 'anchor_btc' / 'anchor_BtC' -> 'anchor_BTC' (same for LTC / DOGE).
//
// This was a security control while the push rail could still write: the
// deterministic on-chain derivation writes 'anchor_' + CHAIN.toUpperCase()
// (actions/anchor.js) into a utf8_general_ci column, so a mixed-case pushed
// variant slipped the case-SENSITIVE flag-day gate AND then collation-collided
// with the derived winner inside reconcileAnchorRewardWinner's MIN(pubkey)
// collapse, deleting the legitimate derived row. With the write path removed
// there is no gate to slip and no row to collide with, so what is left of this
// is presentational: the refusal below names the type with the same spelling the
// derived row carries, which keeps operator logs on both sides of a retired push
// talking about the same reward. The uppercase-chain invariant it documents is
// still load-bearing for the derive path (see the note in
// test/unit/anchorRewardCanonicalGolden.test.js).
// Other reward types (oracle_round, ...) pass through unchanged.
function canonicalizeRewardType(type){
    let str = String(type == null ? '' : type);
    let m   = /^anchor_(btc|ltc|doge)$/i.exec(str);
    if(m) return 'anchor_' + m[1].toUpperCase();
    if(/^anchor_archive$/i.test(str)) return 'anchor_archive';
    // The ANCHOR v7 bundle reward. Lowercase like anchor_archive (it names a leg, not a
    // chain), and folded here for the same presentational reason: the refusal below must
    // name the type with the spelling the derived row carries, so operator logs on both
    // sides of a retired push talk about the same reward.
    if(/^anchor_bundle$/i.test(str)) return 'anchor_bundle';
    return str;
}

// The refusal for an inbound pushvalidatorrewards RPC. There is no admitted case:
// every validator reward is derived from on-chain bytes, so this returns a message
// for whatever the caller asked for, never null.
//
// The wording is load-bearing on the hub side. RewardTracker.isTerminalPushError
// matches /is not pushable|push retired|is required|must be an array/, and an
// un-upgraded hub must read this as FINAL and drop the push rather than burn its
// retry budget against a node that will never accept. Both phrases are here so a
// hub on either side of that predicate's history stops on the first answer.
function rewardPushRetiredError(rewardType){
    let type = canonicalizeRewardType(rewardType);
    return 'reward_type ' + (type || '(unset)') + ' is not pushable: every validator reward is ' +
           'derived on-chain during block processing; push retired';
}

module.exports = { canonicalizeRewardType, rewardPushRetiredError };

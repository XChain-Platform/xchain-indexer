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
 * XChain Indexer - validator-reward push ingest gate
 *
 * Canonicalization for the reward_type of an inbound pushvalidatorrewards RPC.
 * Extracted from the api.js handler so the case-normalization that guards the
 * anchor-reward forge gate is unit-testable without the Express stack.
 *
 ********************************************************************/

'use strict';

// Normalize a per-chain anchor reward_type to its canonical uppercase-suffix
// form: 'anchor_btc' / 'anchor_BtC' -> 'anchor_BTC' (same for LTC / DOGE).
//
// WHY (consensus-safety): the deterministic on-chain derivation writes
// 'anchor_' + CHAIN.toUpperCase() (actions/anchor.js), and the validator_rewards
// column is utf8_general_ci (case-insensitive). A mixed-case pushed variant would
// therefore (a) slip the case-SENSITIVE flag-day gate
// (/^anchor_(BTC|LTC|DOGE)$/) and get written post-flag-day, and (b) collation-
// collide with the derived winner inside reconcileAnchorRewardWinner's
// `WHERE reward_type=?` + MIN(pubkey) collapse, deleting the legitimate derived
// row and forking that node from the fleet. Canonicalizing at the ingest boundary
// forecloses both: no lowercase form can slip the gate or create a colliding
// duplicate. anchor_archive is canonicalized to full lowercase for the same
// reason: its flag-day gate also compares case-sensitively while the derived row
// is written as 'anchor_archive', so a mixed-case push (e.g. 'Anchor_Archive')
// would otherwise slip the gate and collation-collide with the derived winner.
// Other reward types (oracle_round, ...) pass through unchanged.
function canonicalizeRewardType(type){
    let str = String(type == null ? '' : type);
    let m   = /^anchor_(btc|ltc|doge)$/i.exec(str);
    if(m) return 'anchor_' + m[1].toUpperCase();
    if(/^anchor_archive$/i.test(str)) return 'anchor_archive';
    return str;
}

module.exports = { canonicalizeRewardType };

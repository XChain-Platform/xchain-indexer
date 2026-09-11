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
 * XChain Indexer - reward_type canonical naming
 *
 * What survives the retired validator-reward push rail: the executable statement
 * of the uppercase-chain invariant every mirrored anchor reward row must satisfy.
 * The rail itself (the pushvalidatorrewards RPC, its staged flag-day gates and
 * the terminal refusal that replaced them) is gone from src/api.js; this file is
 * the invariant note test/unit/anchorRewardCanonicalGolden.test.js cites, in a
 * form a test can run rather than a comment a refactor can quietly falsify.
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
// collapse, deleting the legitimate derived row. With the whole push rail gone
// there is no gate to slip and no pushed row to collide with, so this is no
// longer a control. What it still is, is the canonical spelling the DERIVE path
// writes: Anchor.prototype._rewardCanonical upper-cases d.CHAIN, while the
// mirror-row copy in the derive code slices the chain verbatim out of
// reward_type, and the two agree only for as long as every mirrored row carries
// an uppercase chain. That is the invariant
// test/unit/anchorRewardCanonicalGolden.test.js asserts against and points here
// for; normalizing case on the derive side would alter a signed string and is a
// flag-day, not test hygiene.
// Other reward types (oracle_round, ...) pass through unchanged.
function canonicalizeRewardType(type){
    let str = String(type == null ? '' : type);
    let m   = /^anchor_(btc|ltc|doge)$/i.exec(str);
    if(m) return 'anchor_' + m[1].toUpperCase();
    if(/^anchor_archive$/i.test(str)) return 'anchor_archive';
    // The ANCHOR v7 bundle reward. Lowercase like anchor_archive (it names a leg, not a
    // chain), and folded here for the same presentational reason: the refusal below must
    // name the type with the spelling the derived row carries, so a bundle reward reads
    // the same everywhere it is logged.
    if(/^anchor_bundle$/i.test(str)) return 'anchor_bundle';
    return str;
}

module.exports = { canonicalizeRewardType };

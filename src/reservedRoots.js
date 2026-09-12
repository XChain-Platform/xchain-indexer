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
 * RESERVED_FUTURE_ROOTS: chain tickers held free so that a chain XChain
 * integrates later still owns its root on every ledger that exists by then.
 *
 * The hole it closes (R8, RULED 2026-09-11): a token root is
 * first-come, so a squatter can take the root of a chain we have not
 * integrated yet for one issuance fee, and the bridge names every foreign
 * asset <ROOT>.<TICK>. Reserving a root reserves its whole ROOT.* subtree
 * through the existing subasset parent gate, so one entry per chain is the
 * entire cost.
 *
 * WHY A LIST AT ALL, when the four-character creation floor that arms with it
 * already reserves every short name: the floor does not cover the four-plus
 * letter chain codes, and it is expected to be LOWERED later behind a priced
 * tier for short names. The day it lowers, this list is what still holds.
 *
 * SCOPE, ruled: chains only. No tokens that live on someone else's chain, and
 * no spelled-out names. When a chain is integrated its ticker moves from here
 * to COINS; both refuse identically, so nothing re-verdicts on the move.
 *
 * MEASURED, not assumed (the reserved chain roots survey,
 * 2026-09-11: 120 names, 720 explorer probes over the six live chains, plus both
 * genesis manifests, D48). Never re-probe this; read the report.
 *
 * Enforced in xchain-indexer/src/actions/issue.js beside the reserved guard,
 * case-folded per D13, reusing the existing verdict 'invalid: TICK (reserved)',
 * and keyed on TICK_NAMESPACE_ACTIVATION (./tick_namespace_activation.js) so no
 * indexed ISSUE anywhere changes verdict on replay.
 *
 * Kept list-identical, ORDER INCLUDED, to xchain-documentation/protocol/constants.js
 * by test/unit/activationConstantsParity.test.js. Order carries no consensus meaning
 * on its own (the guard is a membership test), but pinning it is what makes the
 * parity assert a single deepStrictEqual instead of a set comparison that would pass
 * while one side silently reordered and the other silently dropped a name.
 *
 * Spec: the token bridge spec section 3, R8, D48, D49, D50.
 *
 ********************************************************************/

'use strict';

// The 47 tickers measured FREE on every live chain and in both genesis manifests on
// 2026-09-11, alphabetical, followed by the 6 that are squatted in the mainnet genesis
// manifests and leave through the manifest edit. The two groups are kept in
// that order, and apart, because their provenance differs: the first 47 are reserved
// outright, while for the last 6 this guard only blocks NEW issuance and the section 6
// 'existing row not owned by the bridge role' refusal is the safety net until the
// genesis-track row lands (D50).
//
// Frozen so that a caller holding the array cannot mutate the reserved set at runtime;
// a membership test that could be edited in place is not a consensus rule.
const RESERVED_FUTURE_ROOTS = Object.freeze([
    'ADA', 'ALGO', 'APT', 'ARB', 'ATOM', 'AVAX', 'BCH', 'BNB', 'BSV', 'BTG',
    'CRO', 'DGB', 'DOT', 'EOS', 'ETC', 'ETH', 'FIL', 'FIRO', 'GRS', 'ICP',
    'INJ', 'KAS', 'MNT', 'NEO', 'NMC', 'OP', 'POL', 'PPC', 'RVN', 'SEI',
    'SOL', 'STX', 'SUI', 'TIA', 'TON', 'TRX', 'VET', 'VTC', 'XCP', 'XDP',
    'XEC', 'XLM', 'XMR', 'XRP', 'XTZ', 'ZEC', 'ZK',
    'BASE', 'DASH', 'HBAR', 'HOOD', 'HYPE', 'NEAR',
]);

// Case-folded membership set, built once. The list is the canonical artifact and the set
// is derived from it, never maintained beside it, so the two cannot disagree.
const RESERVED_FUTURE_ROOT_SET = new Set(RESERVED_FUTURE_ROOTS);

// Is `tick` a reserved future chain root? Case-folded per D13, because every tick lookup
// in the database is LOWER(tick): an exact-case test would leave 'eth' free to take the
// row that getTokenInfo('ETH') then returns. A non-string fails closed (false) rather
// than throwing inside a verdict path.
//
// The caller decides WHEN to ask: this is a pure membership test with no height in it,
// and issue.js asks it only at/above TICK_NAMESPACE_ACTIVATION.
function isReservedFutureRoot(tick){
    if(typeof tick !== 'string') return false;
    return RESERVED_FUTURE_ROOT_SET.has(tick.toUpperCase());
}

module.exports = { RESERVED_FUTURE_ROOTS, isReservedFutureRoot };

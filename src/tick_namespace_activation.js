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
 * TICK_NAMESPACE_ACTIVATION: where the tick namespace closes, so a chain
 * XChain integrates later still has its root free on every ledger.
 *
 * Two rules ride this one height, both in the ISSUE handler beside the
 * reserved guard (R8, RULED 2026-09-11):
 *   1. a top-level ISSUE that would CREATE a tick shorter than four
 *      characters is 'invalid: TICK (length)'. Creation only: an edit (the
 *      '^id' form, or a re-ISSUE of a tick that already exists) is untouched,
 *      so every short token issued on the live testnets keeps its owner, its
 *      supply and its admin surface. The floor measures the FULL tick, so a
 *      child such as ABCD.X passes;
 *   2. RESERVED_FUTURE_ROOTS (./reservedRoots.js) joins the guard's COINS +
 *      GAS set, case-folded, verdict 'invalid: TICK (reserved)' reused.
 *
 * WHY ITS OWN CONSTANT rather than TOKEN_BRIDGE_ACTIVATION: the bridge arms
 * only after the base spec's D2 checkpoint cross-check, and the namespace has
 * to close BEFORE anyone squats, not after. The two heights are sized by the
 * operator independently.
 *
 * WHY ACTIVATION-KEYED AT ALL, where the case-folding fix beside it lands
 * unconditional (D13): the reserved and length checks run BEFORE the fee and
 * budget checks (issue.js:310-327 ahead of :370-372 and :710-725), so a mined
 * ISSUE ETH that is refused today on fee would flip its verdict STRING on
 * replay, and no explorer probe can rule one out because only valid rows are
 * served (D49). Below the flag the handler is byte-for-byte today's.
 *
 * Kept value-identical to xchain-documentation/protocol/constants.js by
 * test/unit/activationConstantsParity.test.js.
 *
 * Spec: the token bridge spec section 3, R8, D48, D49, D50.
 *
 ********************************************************************/

'use strict';

// TICK_NAMESPACE_ACTIVATION: the height (per network) on the chain being parsed at/above
// which the four-character creation floor and the RESERVED_FUTURE_ROOTS refusal bind.
// Keyed on the chain's OWN block_index: what it gates is the verdict of an ISSUE mined
// here.
//
// Regtest is 0, so both rules bind on the only venue milestone 1 runs on; the integration
// and e2e fixtures were scanned 2026-09-11 and no real ISSUE of a listed or short name
// exists there (XCP appears only in unit-test mocks, and every scenario ticker is four
// characters or longer).
//
// Testnet holds at the house sentinel until the train that arms it sizes a dated instant
// above the fleet's deploy tip. Mainnet is a genesis-arm candidate under the genesis-arm
// method and stays at the sentinel until the mainnet replicas measure zero mined
// ISSUEs of a short or listed name, valid OR invalid: an armed height below a real one
// would re-verdict it and move that chain's hashes.
const TICK_NAMESPACE_ACTIVATION = {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
};

// Are the namespace rules in effect at height `blockIndex` on `network`? A non-numeric
// height or an unknown network fails closed (false), which here means the LEGACY rule:
// the ISSUE is judged exactly as it was before this file existed. Failing closed toward
// the historical verdict is what keeps replay identical when a caller has no block
// context.
function isTickNamespaceActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = TICK_NAMESPACE_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = { TICK_NAMESPACE_ACTIVATION, isTickNamespaceActive };

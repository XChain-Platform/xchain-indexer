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
 * Balance-dispenser GIVE_AMOUNT positivity flag-day.
 *
 * A format-0 create with GIVE_OWNERSHIP=0 was accepted with GIVE_AMOUNT empty
 * or "0". Nothing required it: the format check at dispenser.js only runs when
 * the field is present, and the emptiness rules beside it only bind
 * GIVE_OWNERSHIP=1. Such a dispenser opens and settles buyer payments as VALID
 * fills that credit nothing, because every downstream guard reads a
 * non-positive GIVE_AMOUNT as "this is an ownership dispenser" and skips:
 * dispense.js clamps only when giveAmountIsPositive, bcmul coerces the empty
 * value to 0, the multiplier==0 reject therefore never fires, and the
 * credit/escrow rows at the bottom are written only under bcgt(GIVE_AMOUNT,0).
 * The auto-close threshold is that same non-positive value, so the dispenser
 * never closes either and keeps absorbing payments. It also feeds give=0 /
 * get>0 rows into the realized-price derivation.
 *
 * Only GIVE_AMOUNT is constrained here. An empty GIVE_ESCROW is a legitimate
 * open-now-refill-later dispenser and is NOT a trap: with GIVE_AMOUNT positive
 * the clamp resolves the multiplier to 0 against a zero GIVE_REMAINING and the
 * dispense settles invalid, consuming nothing.
 *
 * Rejecting a create the engine used to accept re-evaluates already-processed
 * blocks, so it is gated on the block's consensus timestamp: below the
 * threshold the legacy acceptance runs and historical replay is byte-identical.
 *
 * MAINNET IS UNARMED, on the house sentinel (9999999999, year 2286). The
 * dispenser-family cohort anchor (1786060800, 2026-08-07) is already PAST, and
 * a tightening on a retroactive boundary makes a from-genesis replay reject
 * creates the live chain accepted, which is the fork the gate exists to
 * prevent. Naming the activation instant is a separate operator act, as with
 * the sibling sentinels in protocol_changes.js; arming it is a one-line edit
 * here. testnet/regtest run from genesis, matching every dispenser-family
 * activation and the 2.0.0 protocol_changes cohort they mirror.
 *
 * Execution-path gate (create-time acceptance), not a hashing-path change, so
 * indexer-only with no xchain-sync twin, exactly as dispenser_caps_activation.
 *
 ********************************************************************/

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
const DISPENSER_GIVE_AMOUNT_ACTIVATION = {
    mainnet: 9999999999,    // UNARMED sentinel; the instant is the operator's to name
    testnet: 0,
    regtest: 0,
};

// Whether a balance dispenser must carry a positive GIVE_AMOUNT for a block
// whose consensus timestamp is `blockTime` on `network`. Below the threshold ->
// off (legacy acceptance, byte-identical historical replay). Unknown network ->
// off (safe: keeps deployed behavior; boot rejects invalid networks before any
// block is processed).
function isDispenserGiveAmountActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = DISPENSER_GIVE_AMOUNT_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    DISPENSER_GIVE_AMOUNT_ACTIVATION,
    isDispenserGiveAmountActive
};

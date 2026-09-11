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
 * Dispenser amount-positivity flag-day: one threshold, two enforcement points.
 *
 * The DISPENSER pricing chain trusted amounts to be positive and well-formed.
 * The only GET_AMOUNT format check in the create path (dispenser.js) is a
 * conjunct on getTokenInfo, which is loaded only when GET_TICK names a token,
 * so an ordinary native-coin-priced dispenser (empty GET_TICK, explicitly
 * permitted by the GET_TICK rule beside it) stored GET_AMOUNT with no sign,
 * precision or numeric check. isValidAmountFormat is the only thing in the tree
 * that rejects a leading "-", and it never ran on that path. The sibling
 * order.js does not have the hole: it resolves COIN_DECIMALS for a native-coin
 * side instead of skipping, then applies a strict positivity rule.
 *
 * A negative price then survives settlement. In dispense.js the multiplier is
 * floor(available / GET_AMOUNT), which is -1 for any dust payment against a
 * negative price; the GIVE_REMAINING capacity clamp, the batch value-ledger
 * drain and the credit/escrow write are each guarded on multiplier > 0 and all
 * skip, while the single settlement gate tests multiplier == 0 and does not.
 * The row persists VALID with a negative GIVE_AMOUNT, and the GIVE_REMAINING
 * recompute (db.js, bcsub over valid dispenses) SUBTRACTS a negative, inflating
 * remaining escrow above the original deposit for dispenser_close and
 * dispenser_expire to refund in full. That is escrow manufactured from nothing,
 * and it drives the global escrows sum, folded into supply, negative.
 *
 * Both enforcement points ride this one threshold on purpose: create-time and
 * settlement acceptance cannot drift apart on replay if they read one gate.
 * The settlement rule is deliberately about the FILL COUNT rather than about
 * GET_AMOUNT, because three producers feed that count (per-token oracle, FIAT
 * reverse price match, and the non-FIAT divide), two of them from external
 * oracle data, and the value-conservation invariant must not depend on every
 * upstream pricing path being sign-correct.
 *
 * Rejecting an action the engine used to accept re-evaluates already-processed
 * blocks, so it is gated on the block's consensus timestamp: below the
 * threshold the legacy acceptance runs and historical replay is byte-identical.
 *
 * NOT gated, and deliberately outside this module: the non-numeric GET_AMOUNT
 * rejection at the settlement divide. bcdiv calls mathjs.bignumber() on the
 * operand, which THROWS on a non-numeric string; the throw escapes parse() into
 * the block loop, which rolls back and retries the same block forever. The
 * behavior it replaces is therefore "no node commits this block at all", so no
 * committed history can contain one, exactly the argument bcfloorSaturating is
 * already ungated on.
 *
 * MAINNET IS ARMED AT GENESIS (operator ruling 2026-09-09). A tightening on a
 * retroactive boundary only rejects what the live chain accepted when the chain
 * accepted something: read-only against the live indexer databases on
 * 2026-09-09, mainnet holds 0 dispensers and 0 dispenses, so neither the
 * create-time check nor the settlement fill-count check has an action to
 * re-judge and both are the identity function over every mainnet block
 * committed so far. That is why genesis is safe here where the passed cohort
 * anchor (1786060800, 2026-08-07) would not have been if any dispenser existed.
 * The proof is a per-chain OLD-vs-ON replay witness, not this comment.
 * testnet/regtest run from genesis, matching every dispenser-family activation.
 *
 * Execution-path gate (action acceptance), not a hashing-path change, so
 * indexer-only with no xchain-sync twin, exactly as dispenser_caps_activation.
 *
 ********************************************************************/

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
const DISPENSER_AMOUNT_POSITIVITY_ACTIVATION = {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
};

// Whether the dispenser amount-positivity rules bind for a block whose
// consensus timestamp is `blockTime` on `network`. Below the threshold -> off
// (legacy acceptance, byte-identical historical replay). Unknown network -> off
// (safe: keeps deployed behavior; boot rejects invalid networks before any
// block is processed).
function isDispenserAmountPositivityActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = DISPENSER_AMOUNT_POSITIVITY_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    DISPENSER_AMOUNT_POSITIVITY_ACTIVATION,
    isDispenserAmountPositivityActive
};

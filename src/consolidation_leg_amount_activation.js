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
 * Multi-leg consolidation flag-day: a leg's OWN amount must be well-formed.
 *
 * SEND and DESTROY are multi-leg actions that MERGE same-key legs before any
 * leg is validated. send.js keys the merge on DESTINATION|TICK, destroy.js on
 * TICK|MEMO, and both sum with bcadd(...,, DECIMALS), which formats the result
 * to the tick's precision. The only amount-format check in either handler runs
 * AFTER that merge, on the merged total.
 *
 * So consolidation launders an amount no leg was allowed to carry. For a
 * 0-decimals token, one 0.5 leg is rejected ('invalid: AMOUNT (format)') while
 * two 0.5 legs to the same destination merge to '1' and settle; bcadd also
 * ROUNDS at the tick precision, so 0.4 + 0.4 settles as 1 and 1 + 0.5 settles
 * as 2. The token standard says a fractional amount of a 0-decimals token is
 * rejected in every amount-bearing action (nft-standard.md), and it is, right
 * up until a second leg hides it.
 *
 * THE RULE. Above the threshold, a leg whose RAW amount fails
 * isValidAmountFormat for its tick is held OUT of the merge and keeps its own
 * slot, so it reaches the handler's existing per-leg check and records
 * 'invalid: AMOUNT (format)'. Honest sibling legs still settle, which is the
 * per-leg convention both handlers already follow everywhere else. Nothing new
 * is validated: the held-out leg meets the same predicate it always met, one
 * step earlier.
 *
 * It IS consensus-affecting - it rejects legs the engine used to accept, and
 * turns one valid record into two invalid ones - so it is gated on the block's
 * consensus timestamp. Below the threshold the legacy merge key and the legacy
 * merge both run untouched and historical replay stays byte-identical.
 *
 * MAINNET IS UNARMED, on the house sentinel (9999999999, year 2286), exactly as
 * dispenser_amount_positivity_activation: a tightening on a retroactive
 * boundary makes a from-genesis replay reject actions the live chain accepted,
 * which is the fork the gate exists to prevent. Naming the activation instant
 * is a separate operator act and a one-line edit here; the incidence data that
 * should inform it has not been measured yet. testnet/regtest run from genesis,
 * matching the dispenser-family activations.
 *
 * Execution-path gate (action acceptance), not a hashing-path change, so
 * indexer-only with no xchain-sync twin: xchain-sync replicates materialized
 * rows and never runs an action handler.
 *
 ********************************************************************/

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
const CONSOLIDATION_LEG_AMOUNT_ACTIVATION = {
    mainnet: 9999999999,    // UNARMED sentinel; the instant is the operator's to name
    testnet: 0,
    regtest: 0,
};

// Whether the per-leg amount-format rule binds for a block whose consensus
// timestamp is `blockTime` on `network`. Below the threshold -> off (legacy
// merge, byte-identical historical replay). Unknown network or unparseable
// timestamp -> off (safe: keeps deployed behavior).
function isConsolidationLegAmountActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = CONSOLIDATION_LEG_AMOUNT_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    CONSOLIDATION_LEG_AMOUNT_ACTIVATION,
    isConsolidationLegAmountActive
};

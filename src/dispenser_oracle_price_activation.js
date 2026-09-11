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
 * Mode B create-time effective-oracle-price flag-day.
 *
 * A DISPENSER naming an ORACLE_ADDRESS must reference an oracle that already has
 * an EFFECTIVE price (operator ruling 2026-07-25, documented in
 * protocol/actions/dispenser.md). That rule was only ever reachable as a side
 * effect of the oracle USAGE FEE check, which is gated on GIVE_ESCROW > 0. The
 * two obligations have different scopes: the fee is sized by the escrow this
 * action adds and is genuinely nil when nothing is escrowed, while the price
 * precondition is a validity rule that binds every Mode B action.
 *
 * So a create that escrows nothing was never price-checked at all. That is not a
 * corner case: an ownership dispenser (GIVE_OWNERSHIP=1) is REQUIRED to carry an
 * empty GIVE_ESCROW, and once the dispenser-caps cohort is active it can never
 * refill either, so the check had no later chance to run. Such a create was
 * accepted against an oracle that has published nothing effective, locking the
 * tick's ownership in escrow behind a dispenser that cannot settle (settlement's
 * reverseOraclePriceMatch finds no row and matches nothing) until it is
 * cancelled, and using the oracle for free in the meantime.
 *
 * This gate arms the precondition as a STANDALONE check on format-0 creates,
 * independent of GIVE_ESCROW. The fee path is untouched: escrow-bearing creates
 * and refills already reach the same rule through quoteOracleFee, and both now
 * call the one shared implementation (utility.requireEffectiveOraclePrice).
 *
 * Rejecting a create the engine used to accept re-evaluates already-processed
 * blocks, so it is gated on the block's consensus timestamp: below the threshold
 * the legacy acceptance runs and historical replay is byte-identical.
 *
 * MAINNET IS ARMED AT GENESIS (operator ruling 2026-09-09). A create-acceptance
 * tightening on a retroactive boundary only rejects creates the live chain
 * accepted when the chain accepted some: read-only against the live indexer
 * databases on 2026-09-09, mainnet holds 0 dispensers and 0 dispenses, so there
 * is no Mode B create for the standalone price precondition to re-judge and it
 * is the identity function over every mainnet block committed so far. That is
 * why genesis is safe here where the passed cohort anchor (1786060800,
 * 2026-08-07) would not have been if any dispenser existed. The proof is a
 * per-chain OLD-vs-ON replay witness, not this comment. testnet/regtest run from
 * genesis, matching every dispenser-family activation and the 2.0.0
 * protocol_changes cohort they mirror.
 *
 * Execution-path gate (create-time acceptance), not a hashing-path change, so
 * indexer-only with no xchain-sync twin, exactly as dispenser_caps_activation.
 *
 ********************************************************************/

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
const DISPENSER_ORACLE_PRICE_ACTIVATION = {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
};

// Whether a format-0 Mode B create must resolve an effective oracle price regardless
// of GIVE_ESCROW, for a block whose consensus timestamp is `blockTime` on `network`.
// Below the threshold -> off (legacy acceptance, byte-identical historical replay).
// Unknown network -> off (safe: keeps deployed behavior; boot rejects invalid networks
// before any block is processed).
function isDispenserOraclePriceActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = DISPENSER_ORACLE_PRICE_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    DISPENSER_ORACLE_PRICE_ACTIVATION,
    isDispenserOraclePriceActive
};

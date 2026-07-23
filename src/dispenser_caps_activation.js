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
 * DISPENSER lifetime caps flag-day ( / Package 14, 1679).
 *
 * DISPENSER.md documents two lifetime caps that the engine did NOT enforce:
 *   - MAX_DISPENSES = 1000: a dispenser may serve at most 1000 dispenses per fill.
 *     The dispense that reaches the cap still executes; then the dispenser
 *     auto-closes and refunds remaining escrow to the owner (Counterparty
 *     dispense.py "dispense_count + 1 >= limit" then "Closed: Max dispenses
 *     reached").
 *   - MAX_REFILLS = 5: a refill (a format-2 DISPENSER_EDIT that tops up
 *     GIVE_ESCROW) resets the dispense count to 0; the 6th refill is rejected.
 *     Lifetime ceiling: 6 fills x 1000.
 *
 * Enforcing the caps changes which historical DISPENSE/DISPENSER_EDIT actions
 * are accepted or trigger a close, so it re-evaluates already-processed blocks
 * differently (ledger/dispenser state, hence the consensus hashes) and MUST be
 * gated: below the flag-day the legacy uncapped behavior runs (historical replay
 * byte-identical); at/after it the caps are enforced.
 *
 * GATED WITH THE EXISTING DISPENSER-FAMILY COHORT. Keyed on the block's consensus
 * timestamp (data['BLOCK_TIME']) at the coordinated 2.0.0 flag-day (mainnet
 * 1790812800, testnet/regtest genesis), byte-for-byte the shape of its siblings
 * dispense_cancelling_match_activation.js and dispenser_ownership_cancel_activation.js,
 * so ONE fleet deploy-by date governs the whole dispenser-family flip and the
 * family stays calendar-coherent. (The pre-961000 train HEIGHT gate would fit the
 * mechanics too, but splitting the dispenser family across two flag-days is worse
 * than one coherent cohort: nodes would have to reason about two boundaries for
 * one subsystem.  measured zero live mainnet dispensers, so there is no
 * divergent history to replay either way; the cohort is the right home.)
 *
 * EXECUTION-PATH gate (acceptance + auto-close during action processing), NOT a
 * hashing-path change, so INDEXER-ONLY with no xchain-sync twin (xchain-sync reads
 * materialized rows and does not run action handlers), exactly like
 * dispense_cancelling_match / dispenser_ownership_cancel.
 *
 ********************************************************************/

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']). Mainnet flips at the coordinated 2.0.0 contract-era
// flag-day; testnet/regtest are active from genesis, mirroring the 2.0.0
// protocol_changes cohort and the sibling dispenser-family activations.
const DISPENSER_CAPS_ACTIVATION = {
    mainnet: 1790812800,    // 2026-10-01 00:00:00 UTC - coordinated 2.0.0 flag-day; deploy ALL indexers before this time
    testnet: 0,
    regtest: 0,
};

// Whether the MAX_DISPENSES / MAX_REFILLS caps are in effect for a block whose
// consensus timestamp is `blockTime` on `network`. Below the threshold -> off
// (legacy uncapped behavior, byte-identical historical replay). Unknown network
// -> off (safe: keeps deployed behavior; boot rejects invalid networks before any
// block is processed).
function isDispenserCapsActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = DISPENSER_CAPS_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    DISPENSER_CAPS_ACTIVATION,
    isDispenserCapsActive
};

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Ownership-dispenser cancel/expire routing flag-day.
 *
 * Closing an OWNERSHIP dispenser (GIVE_OWNERSHIP=1) transfers the token's
 * escrowed issuer rights. dispenser_close.js computed a single close destination
 * as `sweep > canceller > SOURCE` and, for the ownership branch, transferred the
 * ownership record to that destination whenever it differed from SOURCE. Cancel
 * authority includes GET_ADDRESS (dispenser.js owner check), so a GET_ADDRESS (or
 * SOURCE-side) canceller of an ownership dispenser ACQUIRED the token's issuer
 * rights for free. DISPENSER.md:122 says cancel/expire returns ownership to
 * SOURCE; ONLY a SWEEP-closure delivers ownership to a non-SOURCE destination.
 * (dispenser_expire.js is already correct: it only clears the escrow gate and
 * leaves ownership with SOURCE; the defect is the cancel/sweep close path.)
 *
 * The fix restricts the ownership transfer to the SWEEP path: a cancel or expire
 * close clears the escrow gate and leaves ownership with SOURCE. Because this
 * changes which address holds a token's issuer rights after an already-processed
 * ownership-dispenser cancel, it re-evaluates historical blocks differently
 * (ledger/ownership state, hence the consensus hashes), so it MUST be gated:
 * below the flag-day the legacy canceller-takes-ownership routing runs
 * (historical replay stays byte-identical); at/after it only the sweep path
 * transfers ownership.
 *
 * GATING RATIONALE (Package 14, vs the  zero-dispenser measurement).
 *  measured ZERO live dispensers on all three mainnet chains, so there is
 * no history to replay divergently on mainnet today. The gate is retained
 * anyway, not for replay-of-history, but because it eliminates the MIXED-FLEET
 * divergence window for NEW ownership-dispenser cancels during the rollout: with
 * an activation height every node flips at the SAME coordinated boundary rather
 * than at each node's own deploy time. It costs nothing (below it, byte-identical
 * legacy behavior) and reuses the EXISTING house dispenser flag-day cohort. It is
 * keyed on block TIME with the coordinated 2.0.0 timestamp, byte-for-byte the
 * shape of its sibling dispense_cancelling_match_activation.js (mainnet
 * 1786060800, testnet/regtest genesis), so ONE fleet deploy-by date governs the
 * whole dispenser-family flip.
 *
 * EXECUTION-PATH gate (dispenser close routing), NOT a hashing-path change, so
 * INDEXER-ONLY with no xchain-sync twin (xchain-sync reads materialized rows and
 * does not run action handlers), exactly like dispense_cancelling_match.
 *
 ********************************************************************/

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']). Mainnet flips at the coordinated 2.0.0 contract-era
// flag-day; testnet/regtest are active from genesis, mirroring the 2.0.0
// protocol_changes cohort and dispense_cancelling_match_activation.js.
const DISPENSER_OWNERSHIP_CANCEL_ACTIVATION = {
    mainnet: 1786060800,    // 2026-08-07 00:00:00 UTC - coordinated 2.0.0 flag-day; deploy ALL indexers before this time
    testnet: 0,
    regtest: 0,
};

// Whether the corrected ownership cancel/expire routing (sweep-only transfer) is
// in effect for a block whose consensus timestamp is `blockTime` on `network`.
// Below the threshold -> off (legacy canceller-can-acquire routing, byte-identical
// historical replay). Unknown network -> off (safe: keeps deployed behavior; boot
// rejects invalid networks before any block is processed).
function isDispenserOwnershipCancelActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = DISPENSER_OWNERSHIP_CANCEL_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    DISPENSER_OWNERSHIP_CANCEL_ACTIVATION,
    isDispenserOwnershipCancelActive
};

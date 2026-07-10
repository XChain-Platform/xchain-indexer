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
 * DISPENSE cancelling-dispenser match flag-day.
 *
 * Gates the corrected latest-status correlation in db.findMatchingDispensers
 * (the native-coin DISPENSE trigger path). The legacy subquery correlates the
 * MAX(action_index) latest-status lookup on the STATUS row's own action_index
 * (`s4.dispenser_action_index = s1.action_index`) instead of the dispenser's
 * (`= d1.action_index`, the idiom every sibling query uses: getDispenserInfo,
 * findDispenserSends, findCancelledDispensers, getSweepDestination). The
 * status-setting action index is a different id domain than a dispenser action
 * index, so the legacy predicate only resolves for a dispenser whose SOLE
 * status row is the freshly-created 'open' row (action_index equals
 * dispenser_action_index). The moment a cancel writes a second, 'cancelling'
 * status row, both rows fail the predicate and the dispenser matches NOTHING,
 * even though the `status IN ('open','cancelling')` filter is written
 * precisely so it keeps dispensing during DISPENSER_CLOSE_DELAY. The dropped
 * trigger is discarded (dispense.js deleteActionIndex), so a buyer's native
 * coin is forfeited without tokens, and the two DISPENSE trigger paths
 * diverge (the token-SEND path via findDispenserSends correlates correctly).
 *
 * Correcting the correlation changes how already-valid blocks evaluate (a
 * coin send to a cancelling dispenser that historically produced no DISPENSE
 * would produce one on replay), which changes actions/ledger rows and hence
 * the consensus block hashes for those blocks. It therefore MUST be gated:
 * below the flag-day the legacy (broken) correlation is used so historical
 * replay stays byte-identical; at/after it the corrected correlation applies.
 *
 * Keyed on block TIME with the coordinated 2.0.0 contract-era timestamp
 * (VM_BANNED_ASYNC_MAINNET_TIME / NATIVE_FEE_PRICE_TIME_GATE and the 2.0.0
 * protocol_changes cohort all use 1790812800), so ONE fleet deploy-by date
 * governs the flip. Registered as a standalone twin-style module rather than
 * a protocol_changes.addChange entry to keep this file self-contained and
 * greppable next to the query it gates.
 *
 ********************************************************************/

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']). Mainnet flips at the coordinated 2.0.0 contract-era
// flag-day; testnet/regtest are active from genesis, mirroring the 2.0.0
// protocol_changes cohort (testnet_time/regtest_time = 0).
const DISPENSE_CANCELLING_MATCH_ACTIVATION = {
    mainnet: 1790812800,    // 2026-10-01 00:00:00 UTC - coordinated 2.0.0 flag-day; deploy ALL indexers before this time
    testnet: 0,
    regtest: 0,
};

// Whether the corrected cancelling-dispenser correlation is in effect for a
// block whose consensus timestamp is `blockTime` on `network`. Below the
// threshold -> off (legacy broken correlation, byte-identical historical
// replay). Unknown network -> off (safe: keeps deployed behavior; boot
// rejects invalid networks before any block is processed).
function isDispenseCancellingMatchActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = DISPENSE_CANCELLING_MATCH_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    DISPENSE_CANCELLING_MATCH_ACTIVATION,
    isDispenseCancellingMatchActive
};

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
 * VM oracle stale-round VISIBILITY flag-day.
 *
 * db.getOracleDataForVM() pre-loads two views of the same price_snapshots
 * table: `prices` (what xchain.oracle.getPrice() reads: the pair's tip round)
 * and `rounds` (what xchain.oracle.getPriceAtRound() reads: finalized history).
 * The freshness guard is applied to the FIRST view only: a tip whose
 * consensus timestamp is older than ORACLE_MAX_PRICE_AGE_SECONDS relative to
 * the block being processed is dropped from `prices` entirely, while `rounds`
 * still carries that same round. The two views therefore disagree about
 * whether the round EXISTS, not merely about whether its price is fresh.
 *
 * That disagreement is a fund-loss path in the price-bet template family. A
 * timestamp-settled bet decides on the first finalized round at/after its
 * settleTime, and it learns the tip round from getPrice():
 *
 *   settle()  requires a non-null getPrice() before it may walk history, so
 *             during an oracle stall it reverts ("no oracle data yet") even
 *             though the deciding round is sitting in `rounds`;
 *   reclaim() voids the bet when getPrice() is null (read as "the oracle
 *             never produced a qualifying round").
 *
 * So during a stall the LOSER's void is the only executable transition, which
 * is exactly what the template's own guard was written to prevent. The gap is
 * in the pre-load, not in the template: the contract asks a reasonable
 * question ("what is the newest finalized round, and when was it?") and the
 * suppression answers "there is none".
 *
 * WHAT THIS GATE CHANGES. At/after the activation height the stale tip is no
 * longer dropped from `prices`; it is emitted with its PRICE WITHHELD:
 *
 *     { price: null, roundNumber: <n>, timestamp: <t>, stale: true }
 *
 * The freshness guarantee is unchanged - no contract can read a stale price
 * value through getPrice(), exactly as before - but the round's identity and
 * consensus timestamp stay visible, which is all a liveness guard needs to
 * tell "the oracle stalled" apart from "the oracle never ran". Below the
 * height the row is dropped as before, so historical replay is byte-identical.
 *
 * WHY THE `rounds` LOOP IS NOT ROW-FILTERED. The symmetric-looking remedy
 * (apply isStale() per row in the `rounds` loop too) is strictly worse and is
 * deliberately NOT implemented: staleness is measured against the block being
 * processed, so it is true of ALL history older than the max age. Filtering
 * rows would make getPriceAtRound() return null for every round more than
 * ORACLE_MAX_PRICE_AGE_SECONDS old, which (a) breaks the immutable-history
 * contract the accessor exists to provide, (b) makes a timestamp-settled bet
 * settle on a LATER round than the one consensus history designates, so the
 * winner would depend on when settle() is called, and (c) hands the round-
 * number bet template a universal void: its reclaim() guard is
 * "getPriceAtRound(settleRound) === null", so every such bet would become
 * reclaimable by the loser 30 minutes after its round published. This gate
 * closes the asymmetry from the other side: both views now agree on which
 * rounds EXIST, and they differ only on whether a stale PRICE VALUE may be
 * read, which is the freshness filter's actual purpose.
 *
 * EXECUTION-PATH gate (a VM read), NOT a hashing-path change: the pre-load
 * runs during block processing, and xchain-sync's BlockHasher reads the
 * already-materialized contract rows without re-running the VM, so this gate
 * is INDEXER-ONLY and has no xchain-sync twin (same shape as
 * oracle_snapshot_age_causality_activation.js).
 *
 * ARMED at the shared pre-freeze deploy-train boundary (BTC 963000 /
 * LTC 3162000 / DOGE 6338000), value-equal to CARET_REF_STRICT_ACTIVATION and
 * LIST_EDIT_RESOLUTION_ACTIVATION so the whole train deploys as one; testnet
 * (fresh 2026-08-10 genesis) and regtest are genesis-active, matching the
 * PKG3_SANDBOX_ACTIVATION template. The indexer fleet must be deployed before
 * BTC 963000.
 *
 * NOTE FOR DEPLOYERS: a contract instance already deployed on a chain that has
 * not yet crossed its height keeps the old behaviour until it does. The
 * operator-facing advisory lives in the priceBetTimed template README.
 *
 ********************************************************************/

// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height a stale tip round is emitted with its price
// withheld; below it the row is dropped entirely (legacy behaviour).
const ORACLE_STALE_ROUND_VISIBILITY_ACTIVATION = {
    'BTC:mainnet':  963000,
    'LTC:mainnet':  3162000,
    'DOGE:mainnet': 6338000,
    testnet: 0,
    regtest: 0,
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Unknown / unarmed -> undefined -> inert/off.
function _activationThreshold(network, coin){
    if(coin != null && ORACLE_STALE_ROUND_VISIBILITY_ACTIVATION[coin + ':' + network] !== undefined)
        return ORACLE_STALE_ROUND_VISIBILITY_ACTIVATION[coin + ':' + network];
    return ORACLE_STALE_ROUND_VISIBILITY_ACTIVATION[network];
}

// Whether stale-tip metadata is visible to the VM at `blockIndex` on `network`
// for `coin`. Below the threshold / unarmed / unknown chain -> off (the stale
// tip is dropped, byte-identical historical replay).
function isOracleStaleRoundVisibilityActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    ORACLE_STALE_ROUND_VISIBILITY_ACTIVATION,
    isOracleStaleRoundVisibilityActive
};

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
 * : action-scoped price-sync barrier.
 *
 * The price/oracle mirror barriers in XChainIndexer wait on EVERY block, so on
 * mainnet every tip block burns the full HUB_PRICE_SYNC_TIMEOUT_MS (60s) waiting
 * for a mirror it never reads: the hub finalizes one price round per 600s, the
 * same cadence as a BTC block, so a tip block can essentially never be covered
 * by a round anchored at or after it. Measured 2026-07-27 on node-host-a: BTC 11
 * timeouts, DOGE 12, LTC 7 in one 15-minute window, with LTC still reporting
 * healthy, so the health check does not even detect it.
 *
 * A block that reads no price is byte-identical whether the mirror is current or
 * a week stale, so waiting on it is pure cost. This predicate decides whether a
 * block can reach a price read at all; the caller skips the barriers when it
 * cannot.
 *
 * *** NO FLAG-DAY GATE, and this is deliberate. *** Every sibling module in this
 * directory gates a consensus value and therefore needs an activation height.
 * This one does not: the barrier is a node-local WAIT decision, never persisted
 * and never hashed (the invariant is written out at XChainIndexer.js, above the
 * price barrier). A node that waits and a node that skips produce identical
 * output for a block that reads no price, so the predicate does not have to be
 * deterministic across nodes. It only has to be SOUND.
 *
 * SOUNDNESS is the whole design. Waiting when we did not need to costs latency.
 * Skipping when the block DOES read a price reintroduces exactly the
 * live-node-vs-resync divergence the barriers exist to close, which is a fork.
 * So every uncertain case resolves to `true` (wait), and the predicate is a
 * deliberate OVER-approximation:
 *
 *   1. Any transaction in the block means wait. The rows come from the decoder,
 *      which stores only XChain-relevant transactions, so a block with no XChain
 *      activity (the overwhelming majority of mainnet blocks today) returns an
 *      empty set and skips. Refining this to the specific reader action classes
 *      (native-fee-paying actions, DISPENSER creates carrying an ORACLE_ADDRESS,
 *      payments to a FIAT dispenser, DEPLOY/EXECUTE, since the VM exposes
 *      oracle.getPrice to contract code) would need this module to re-derive the
 *      action type from the raw payload, duplicating decoder/mapper logic. A
 *      disagreement between that copy and the real decode would be silent and
 *      would be a fork, so v1 does not attempt it. The seam is here when the
 *      traffic justifies the risk.
 *
 *   2. The end-of-block passes are NOT covered here, because they cannot be.
 *      processCrossChainCalls (utility.js) injects XEXEC actions and runs XCALL
 *      callback isolates from hub-mirror state on blocks that contain no
 *      transaction at all, and those run the VM, which can read the price
 *      mirror. Predicting them would mean re-running their due-set queries
 *      before the block transaction opens, and the answer could still change
 *      before the pass executes, since the mirror keeps syncing concurrently.
 *      Instead the guarantee is enforced where it is exact: db._assertPriceBarrierNotSkipped()
 *      fails the block closed at the price-read choke points themselves if this
 *      predicate said "no read" and something read anyway. The block rolls back
 *      and retries with the barrier forced. That also covers any future reader
 *      nobody thought to enumerate here, which is the point.
 *
 ********************************************************************/

// Whether this block can reach a price/oracle mirror read through one of its own
// transactions. Sound over-approximation: true means "wait on the barriers",
// false means "provably no transaction-borne reader". See the header for why the
// end-of-block passes are handled by the choke-point assertion rather than here.
//
// blockTransactions is the (fan-out-collapsed) decoder row set for the block.
// Anything unexpected (null, a non-array, a bad length) resolves to true.
function blockMayReadPrice(blockTransactions){
    if(!Array.isArray(blockTransactions)) return true;
    return blockTransactions.length > 0;
}

module.exports = {
    blockMayReadPrice
};

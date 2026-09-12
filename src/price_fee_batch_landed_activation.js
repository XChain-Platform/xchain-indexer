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
 * Flag-day: native-coin fee pricing reads only rounds whose BATCH has LANDED
 * on chain at or before the block being priced.
 *
 * THE DEFECT. db.getLatestPrice() selects the newest finalized round in
 * whatever price_snapshots the node holds, bounded by the round's own
 * consensus timestamp (the H-3 branch) or by reference_block. Neither bound
 * says anything about when the round became readable FROM THE CHAIN. A
 * hub-connected node's mirror holds a round the instant oracle consensus
 * finalizes it, which is one batch window before the PRICE batch carrying it
 * is mined; a chain-only node cannot hold that round until the batch lands in
 * a block it has processed. Both nodes are valid, both are honest, and they
 * price the same fee-bearing action against different rounds. A price move
 * past the 0.95-1.10 fee tolerance inside the landing latency, or a landing
 * later than the staleness bound, turns that into opposite verdicts on the
 * same action: a fee fork between two node kinds rather than between a good
 * node and a broken one.
 *
 * THE RULE. At/after the threshold, getLatestPrice carries an ADDITIONAL
 * bound: the round's batch_block_time (the clock of the block the batch
 * carrying this round landed in, stamped by the hub's batch ingest) must be
 * non-zero and at or below the time of the block being priced. A round whose
 * batch has not landed yet, or landed in a block later than this one, is not
 * selectable on ANY node kind, so both kinds price against the same round: the
 * newest round the chain itself could have shown them. The bound is ADDED,
 * never swapped, so the selectable row set can only shrink and no arming can
 * make a node accept a fee it refuses today.
 *
 * THE AXIS IS TIME, NOT HEIGHT, and deliberately. A batch lands on ONE chain,
 * so the landing block's height is a height on that chain alone: comparing it
 * against the processing chain's own height is the vacuity H-3 already
 * documents for reference_block. The landing block's clock is comparable on
 * every chain, it is the same chain-derived quantity the staleness guard and
 * the H-3 selection already compare, and the fleet-wide waitForPriceSyncTime
 * barrier is what makes a node's mirror provably complete against it.
 *
 * FAILS CLOSED WITHOUT A BLOCK TIME. Armed, the rule cannot be evaluated for a
 * caller that supplies no chain-derived block time, so getLatestPrice returns
 * no price rather than falling back to the unbounded selection. Every
 * consensus caller (utility.getFeeOraclePrices) passes the evaluated block's
 * time already; a caller that does not is a programming error on a consensus
 * path, and answering it with an unbounded price is the fork this gate exists
 * to close.
 *
 * WHY GATED. It changes which round a fee is priced against, so it changes
 * action validity and a replay across the boundary re-derives different
 * verdicts. Below the threshold the query text and its argument list are
 * byte-identical to the pre-gate ones and a from-genesis replay is unchanged.
 *
 * NO NETWORK IS ARMED YET, and each one has a named prerequisite rather than a
 * pending decision:
 *
 *   mainnet  Unarmed. Native-coin fee pricing is live history there, and the
 *            rule makes the freshest selectable round one batch window old,
 *            which only fits inside the pinned staleness bound while the batch
 *            cadence ceiling holds. Arm at a coordinated future height once
 *            the cadence ceiling is proven against the live publisher.
 *   testnet  Unarmed. Same reasoning on a chain that already carries
 *            fee-bearing history: the parity measurement between a
 *            hub-connected node and a chain-only node is what sizes this, and
 *            a height below the tip would fork the replay of blocks already
 *            settled.
 *   regtest  Unarmed. No validator federation publishes on a regtest stack, so
 *            no batch ever lands and every round there is seeded directly into
 *            price_snapshots with no landing stamp. Arming before the seeder
 *            stamps a landing time would leave every USD-priced regtest action
 *            unpriceable.
 *
 * CONSENSUS-PATH gate (it decides action validity), indexer-only: the hub
 * writes the landing stamp but never selects a fee price, and xchain-sync
 * replicates materialized rows without re-running fee validation.
 *
 ********************************************************************/

'use strict';

// Per-network activation, interpreted as the PROCESSING chain's own
// block_index (the value getLatestPrice is already given). null means unarmed
// at every height; an unknown network resolves to undefined and is inert for
// the same reason.
const PRICE_FEE_BATCH_LANDED_ACTIVATION = {
    mainnet: null,
    testnet: null,
    regtest: null,
};

// Resolve the threshold: '<COIN>:<network>' key first (so one chain can be
// armed ahead of its siblings), then the bare network key.
function _activationThreshold(network, coin){
    if(coin != null && PRICE_FEE_BATCH_LANDED_ACTIVATION[coin + ':' + network] !== undefined)
        return PRICE_FEE_BATCH_LANDED_ACTIVATION[coin + ':' + network];
    return PRICE_FEE_BATCH_LANDED_ACTIVATION[network];
}

// Whether fee pricing carries the landed-batch bound at `blockIndex` on
// `network` for `coin`. Unarmed network, unknown network or unparseable height
// -> false, which is the deployed path and a byte-identical replay.
function isPriceFeeBatchLandedActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === null || threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    PRICE_FEE_BATCH_LANDED_ACTIVATION,
    isPriceFeeBatchLandedActive
};

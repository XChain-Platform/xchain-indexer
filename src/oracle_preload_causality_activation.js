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
 * Flag-day: the VM oracle preload gets a causal bound on non-reference chains.
 *
 * THE DEFECT. Every read in db.getOracleDataForVM() bounds itself with
 * `reference_block <= blockCap`, where blockCap is the PROCESSING chain's own
 * block_index. price_snapshots.reference_block is a BTC height on every row
 * (reference_chain 'BTC'; the hub anchors one price round per BTC block). On
 * BTC that comparison is exact and the bound holds. On LTC (~3.15M) and DOGE
 * (~6.3M) the local height sits far above any BTC anchor (~961k), so the
 * predicate matches every row in the table, future rounds included. A contract
 * executing at LTC block N therefore observes price rounds the hub finalized
 * AFTER N, and which rounds those are depends on how far that node's mirror has
 * advanced. getPrice() / getPriceAtRound() / getSnapshotAge() are VM-visible, so
 * two nodes at different mirror depths write different contract state and fork
 * the consensus contract_hash. The staleness guard is no backstop: a round
 * stamped after the block yields a negative age, which reads as fresh.
 *
 * THE RULE. At/after the threshold, and only on a non-reference chain, each of
 * the four preload reads carries an ADDITIONAL `block_timestamp <= ?` bound
 * against the block's own consensus timestamp. The round's consensus timestamp
 * and the block time are the same two chain-derived quantities the staleness
 * guard already compares, and getLatestPrice's H-3 branch (db.js, keyed by
 * utility.js's `(coin !== 'BTC') && isNativeFeePriceTimeGateActive`) already
 * selects on exactly this axis for exactly this reason. Determinism across
 * nodes rests on the time-keyed price barrier: XChainIndexer's
 * waitForPriceSyncTime(blockTime) runs on EVERY chain, while the height barrier
 * beside it is BTC-only, so blockTime is the one anchor a non-BTC node can
 * prove its mirror complete against. Excluding future-stamped rows also closes
 * the negative-age hole by construction, so isStale needs no clamp.
 *
 * BTC IS CARVED OUT, PERMANENTLY, not merely unarmed: isOraclePreloadCausality-
 * Active returns false for the reference chain at any height. Bitcoin permits a
 * block timestamp to lead its neighbours and to land out of order, so bounding
 * the reference chain on time would admit rounds anchored after the block being
 * processed: this very defect, manufactured on the one chain that does not have
 * it. The exact height cap is the correct bound there and it stays.
 *
 * THE BOUND IS ADDED, NEVER SWAPPED. At/after the threshold the SQL carries the
 * time predicate AND the height predicate it carries today, so the admitted row
 * set can only shrink. No arming of this gate on any chain can widen what a
 * contract sees, which is the property that makes the flag day safe to land
 * ahead of the heights that arm it.
 *
 * WHY GATED. It changes what the VM reads and therefore what contracts write,
 * so a replay across the boundary re-derives different contract_executions,
 * emissions and state. Below the threshold the four queries and their bound
 * parameters are byte-identical to the pre-gate ones and a from-genesis replay
 * is unchanged.
 *
 * MAINNET IS UNARMED, on the house sentinel (9999999999, year 2286): naming the
 * activation heights is a ratified-deploy-train decision and a one-line edit
 * here. testnet and regtest run from genesis, so the bounded path is exercised
 * end to end pre-launch.
 *
 * EXECUTION-PATH gate (a VM read) rather than a change to how a row is hashed,
 * so it is indexer-only with no xchain-sync twin: xchain-sync's BlockHasher
 * reads already-materialized contract rows and never re-runs the VM. Sibling
 * gates over the same preload: oracle_snapshot_age_causality_activation.js and
 * oracle_stale_round_visibility_activation.js, both of which stay in force.
 *
 ********************************************************************/

'use strict';

// The chain whose heights price_snapshots.reference_block records. Its height
// cap is exact, so it never takes the time bound.
const ORACLE_PRELOAD_CAUSALITY_REFERENCE_COIN = 'BTC';

// Per-chain activation, interpreted as the processing chain's OWN block_index
// (the value db.getOracleDataForVM already caps on). Mainnet unarmed on the
// house sentinel; testnet and regtest genesis-active.
const ORACLE_PRELOAD_CAUSALITY_ACTIVATION = {
    mainnet: 9999999999,    // UNARMED sentinel; the heights are the operator's to name
    testnet: 0,
    regtest: 0,
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Unknown -> undefined -> inert.
function _activationThreshold(network, coin){
    if(coin != null && ORACLE_PRELOAD_CAUSALITY_ACTIVATION[coin + ':' + network] !== undefined)
        return ORACLE_PRELOAD_CAUSALITY_ACTIVATION[coin + ':' + network];
    return ORACLE_PRELOAD_CAUSALITY_ACTIVATION[network];
}

// Whether the VM oracle preload carries its consensus-time bound at `blockIndex`
// on `network` for `coin`. The reference chain is off at every height (its
// height cap is exact, and a time bound there would admit rounds anchored after
// a forward-skewed block). Below the threshold, unknown network or unparseable
// height -> off, which is the deployed path and a byte-identical replay.
function isOraclePreloadCausalityActive(blockIndex, network, coin){
    if(coin === ORACLE_PRELOAD_CAUSALITY_REFERENCE_COIN) return false;
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    ORACLE_PRELOAD_CAUSALITY_ACTIVATION,
    ORACLE_PRELOAD_CAUSALITY_REFERENCE_COIN,
    isOraclePreloadCausalityActive
};

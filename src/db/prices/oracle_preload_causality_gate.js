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
 * The VM oracle preload carries a causal bound on non-reference chains.
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
 * THE RULE. On a non-reference chain, each of the four preload reads carries
 * an ADDITIONAL `block_timestamp <= ?` bound
 * against the block's own consensus timestamp. The round's consensus timestamp
 * and the block time are the same two chain-derived quantities the staleness
 * guard already compares, and getLatestPrice's H-3 branch (db/prices/index.js, keyed by
 * utility/native_fee.js's `(coin !== 'BTC') && isNativeFeePriceTimeGateActive`) already
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
 * THE BOUND IS ADDED, NEVER SWAPPED. The SQL carries the time predicate AND the
 * height predicate it carries today, so the admitted row set can only shrink.
 *
 * ADMISSION ERA. Where the mirror-admission consumer gate is armed for the processing
 * chain, the time bound is replaced by the round's signed admission height: a round with
 * admit_block_<c> binds on admit_block_<c> <= B, and a legacy round with no height for the
 * chain keeps binding on block_timestamp <= t(B). The signed height is part of the round's
 * consensus proof and does not move with block stamps, so a block stamped earlier than its
 * parent selects the same round it would by height. The consumer gate, and with it a null
 * mainnet, is inherited rather than duplicated.
 *
 * EXECUTION-PATH rule (a VM read) rather than a change to how a row is hashed,
 * so it is indexer-only with no xchain-sync twin: xchain-sync's BlockHasher
 * reads already-materialized contract rows and never re-runs the VM. Sibling
 * gates over the same preload: the oracle_snapshot_age_causality_activation and
 * oracle_stale_round_visibility_activation registry rows, both of which stay in force.
 *
 ********************************************************************/

'use strict';

const { copy } = require('../../consensus/gate_registry');
const { isMirrorAdmissionConsumerActive } = require('../../consensus/gates/mirror_admission_gate.js');

const ADMISSION_COLUMNS = Object.freeze({ LTC: 'admit_block_ltc', DOGE: 'admit_block_doge' });

const ORACLE_PRELOAD_CAUSALITY_REFERENCE_COIN = copy('oracle_preload_causality_activation.ORACLE_PRELOAD_CAUSALITY_REFERENCE_COIN');

// Whether the VM oracle preload carries its consensus-time bound. The reference
// chain is off at every height because its height cap is exact, and a time bound
// there would admit rounds anchored after a forward-skewed block. An unparseable
// height stays fail-closed because callers may not have a usable block index.
function isOraclePreloadCausalityActive(blockIndex, network, coin){
    if(coin === ORACLE_PRELOAD_CAUSALITY_REFERENCE_COIN) return false;
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    return true;
}

// Whether the preload binds on the signed admission height at `blockIndex`. Never on the
// reference chain, and only for a chain that has an admission column.
function isOraclePreloadAdmissionActive(blockIndex, network, coin){
    if(coin === ORACLE_PRELOAD_CAUSALITY_REFERENCE_COIN) return false;
    if(!Object.prototype.hasOwnProperty.call(ADMISSION_COLUMNS, coin)) return false;
    return isMirrorAdmissionConsumerActive(coin, network, blockIndex);
}

// The WHERE fragment and bindings that bound a price_snapshots read at block B. Empty
// when no bound is armed, which is the pre-gate query byte for byte.
function oraclePreloadBound(blockIndex, blockTime, network, coin){
    if(!Number.isFinite(blockTime)) return { sql: '', args: [] };
    if(isOraclePreloadAdmissionActive(blockIndex, network, coin)){
        let col = ADMISSION_COLUMNS[coin];
        return {
            sql:  ' AND ((' + col + ' IS NULL AND block_timestamp <= ?) OR (' + col + ' IS NOT NULL AND ' + col + ' <= ?))',
            args: [blockTime, Number(blockIndex)]
        };
    }
    if(isOraclePreloadCausalityActive(blockIndex, network, coin))
        return { sql: ' AND block_timestamp <= ?', args: [blockTime] };
    return { sql: '', args: [] };
}

module.exports = {
    isOraclePreloadAdmissionActive,
    oraclePreloadBound,
    ORACLE_PRELOAD_CAUSALITY_REFERENCE_COIN,
    isOraclePreloadCausalityActive
};

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
 * VM oracle getSnapshotAge() causality flag-day.
 *
 * db.getOracleDataForVM() pre-loads the "snapshot age" a contract reads via
 * xchain.oracle.getSnapshotAge(). The legacy age query
 *
 *     SELECT MAX(reference_block) AS latest_block
 *     FROM price_snapshots WHERE status = 'finalized'
 *
 * has NO block cap, unlike every sibling query in the same function (getPrice /
 * getPriceAtRound all constrain `reference_block <= ?` to the block being
 * processed). So a node replaying block N whose DB already holds a FUTURE
 * finalized snapshot at block N+k reads latest_block = N+k and computes
 * snapshotAge = max(0, N − (N+k)) = 0, while the node that first processed block
 * N (before N+k existed) computed a positive age. The value is VM-visible: a
 * contract branches on getSnapshotAge(), so the divergence forks
 * contract_executions / emissions / state and hence the consensus contract_hash
 * between a fully-synced node and one mid-catch-up (and across any reorg that
 * re-lands a later snapshot). The spec also notes an LTC/DOGE age unit concern;
 * the causal cap is the consensus-critical half fixed here.
 *
 * The fix caps the age query at the processing block (`reference_block <= ?`,
 * blockCap = blockIndex), matching its siblings. Because the capped query
 * re-evaluates already-processed blocks differently (a block that historically
 * saw a future snapshot would now see the correct past one), it changes VM
 * output and thus the contract hash, so it MUST be height-gated: below the
 * activation height the uncapped legacy query runs (historical replay stays
 * byte-identical); at/after it the causal cap applies.
 *
 * Gate semantics mirror the sibling causality-gate modules in this repo: keyed
 * on the processing chain's OWN local `block_index`, '<COIN>:<network>' lookup
 * first, then the bare network key; unknown -> inert/off (legacy uncapped path,
 * which preserves deployed behavior).
 *
 * EXECUTION-PATH gate (a VM read), NOT a hashing-path change: getOracleDataForVM
 * runs the oracle read during block processing; xchain-sync's BlockHasher reads
 * the already-materialized contract rows and never re-runs the VM, so this gate
 * is INDEXER-ONLY and has no xchain-sync twin.
 *
 * ARMED 2026-07-22 (ratified pre-961000 deploy train). mainnet is gated per
 * coin at the ratified train heights (BTC 961000, LTC 3154250, DOGE 6319000);
 * testnet and regtest are genesis-active (both pre-launch, so every node deploys
 * together and the capped path is exercised end to end), matching the
 * PKG3_SANDBOX_ACTIVATION template in xchain-vm/src/index.js. The indexer fleet
 * must be deployed before BTC 961000.
 *
 ********************************************************************/

// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height the causally-capped age query runs; below it
// the legacy uncapped query runs. ARMED 2026-07-22 at the ratified deploy-train
// heights; testnet + regtest genesis-active (pre-launch), matching
// PKG3_SANDBOX_ACTIVATION.
const ORACLE_SNAPSHOT_AGE_CAUSALITY_ACTIVATION = {
    'BTC:mainnet':  961000,
    'LTC:mainnet':  3154250,
    'DOGE:mainnet': 6319000,
    testnet: 0,
    regtest: 0,
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Unknown / unarmed -> undefined -> inert/off.
function _activationThreshold(network, coin){
    if(coin != null && ORACLE_SNAPSHOT_AGE_CAUSALITY_ACTIVATION[coin + ':' + network] !== undefined)
        return ORACLE_SNAPSHOT_AGE_CAUSALITY_ACTIVATION[coin + ':' + network];
    return ORACLE_SNAPSHOT_AGE_CAUSALITY_ACTIVATION[network];
}

// Whether the causal snapshot-age cap is in effect at `blockIndex` on `network`
// for `coin`. Below the threshold / unarmed / unknown chain -> off (legacy
// uncapped query, byte-identical historical replay).
function isOracleSnapshotAgeCausalityActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    ORACLE_SNAPSHOT_AGE_CAUSALITY_ACTIVATION,
    isOracleSnapshotAgeCausalityActive
};

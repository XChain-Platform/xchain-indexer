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
 * Stake-weighted-quorum SOURCE-CAP flag-day (SWQ-TRUNC-1 liveness half).
 *
 * The source-keyed stake-weight query (_stakeWeightsSql) feeds the hashed
 * `stakes_root`. Its original safety cap bounded the raw KEY-row count
 * (ORDER BY source,pubkey LIMIT VALIDATOR_QUERY_LIMIT), so one source with
 * >VALIDATOR_QUERY_LIMIT delegated keys could fill the window and evict honest
 * sources from the weighted snapshot. The primitive already fails CLOSED on a
 * truncated snapshot (the safety forge is shut); this flag-day closes the
 * remaining LIVENESS residual by capping the consensus UNIT - distinct staking
 * SOURCES - plus a generous per-source key bound, so truncation triggers only at
 * a genuinely large federation instead of at a key-spamming single source.
 *
 * Because the capped query changes WHICH rows feed `stakes_root`, this is a
 * hashed-consensus-root change, gated exactly like state_commitment_activation.js:
 * below the height the legacy uncapped key-LIMIT is used; at/after it the windowed
 * source-cap is used. For any federation under the caps the two produce the SAME
 * set, so the boundary is inert for honest data (the SMT keys on pubkey+capability,
 * so row order is irrelevant); it diverges only for the >cap case it exists to bound.
 *
 * Gate semantics MIRROR state_commitment_activation.js: keyed on the processing
 * chain's OWN local `block_index` (capability staking + the stakes_root are
 * BTC-only, so only the BTC heights are load-bearing; the LTC/DOGE mainnet entries
 * are inert - those chains commit the EMPTY stakes_root - and are pinned only for
 * pattern parity). '<COIN>:<network>' lookup first, then the bare network key;
 * unknown -> inert/off (uncapped legacy path, which is safe).
 *
 * The two cap constants live HERE (not in the per-coin config) because they are
 * this flag-day's parameters and must be identical in xchain-indexer + xchain-sync
 * or the stakes_root forks; the byte-identical twin lives in
 * xchain-sync/src/swq_source_cap_activation.js and the cross-repo twin guard
 * (test/unit/rollback-coverage.test.js) locks the two files equal.
 *
 ********************************************************************/

const { get, copy, activeAt } = require('./protocol_changes');

const STAKE_WEIGHT_MAX_SOURCES = copy('swq_source_cap_activation.STAKE_WEIGHT_MAX_SOURCES');
const STAKE_WEIGHT_MAX_KEYS_PER_SOURCE = copy('swq_source_cap_activation.STAKE_WEIGHT_MAX_KEYS_PER_SOURCE');

const SWQ_SOURCE_CAP_ACTIVATION = copy('swq_source_cap_activation.SWQ_SOURCE_CAP_ACTIVATION');

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Production callers on mainnet/testnet MUST pass coin; a coin-less
// lookup on those networks finds no key and stays inert (off = legacy uncapped).
function _activationThreshold(network, coin){
    if(coin != null && SWQ_SOURCE_CAP_ACTIVATION[coin + ':' + network] !== undefined)
        return SWQ_SOURCE_CAP_ACTIVATION[coin + ':' + network];
    return SWQ_SOURCE_CAP_ACTIVATION[network];
}

// Whether the stake-weight source-cap is in effect at `blockIndex` on `network`
// for `coin`. Below the threshold -> off (legacy uncapped key-LIMIT path).
// Unknown network/coin -> off (safe: the legacy path is unchanged).
function isSwqSourceCapActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    STAKE_WEIGHT_MAX_SOURCES,
    STAKE_WEIGHT_MAX_KEYS_PER_SOURCE,
    SWQ_SOURCE_CAP_ACTIVATION,
    isSwqSourceCapActive
};

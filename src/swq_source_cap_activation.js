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

// CONSENSUS-CRITICAL caps on the source-keyed stake-weight snapshot. MUST be equal
// in xchain-indexer + xchain-sync (a drift forks the stakes_root at/after the
// activation height).
//   STAKE_WEIGHT_MAX_SOURCES         - cap on DISTINCT staking SOURCES in a weighted
//                                      snapshot (the consensus unit; Σ weight over
//                                      distinct sources = S). Over-fetched by one so a
//                                      genuinely larger federation is flagged truncated
//                                      and the primitive fails closed (a coordinated
//                                      cap raise then re-opens liveness).
//   STAKE_WEIGHT_MAX_KEYS_PER_SOURCE - cap on effective keys returned per source. Bounds
//                                      only the row/leaf count for a key-spamming source;
//                                      dropping a source's excess keys does NOT change its
//                                      weight (weight is per source, counted once) and does
//                                      NOT set truncated. Generous: no legit source
//                                      delegates near this many keys.
const STAKE_WEIGHT_MAX_SOURCES         = 1000;
const STAKE_WEIGHT_MAX_KEYS_PER_SOURCE = 64;

// Per-chain activation height, interpreted as the processing chain's OWN block_index
// (same semantics as STATE_COMMITMENT_ACTIVATION). At/after the height the windowed
// source-cap is applied; below it the legacy uncapped key-LIMIT path runs.
//
// Option B (separate later height): the BTC:mainnet cap arms AFTER STATE_COMMITMENT
// (958500, ~2026-07-17) and AT/BEFORE STAKE_WEIGHTED_QUORUM arms (961000, ~2026-08-04),
// so the eviction fix is live when weighted quorum goes live without an 8-day
// hashed-root fleet-deploy race. For sub-cap honest federations the capped and
// uncapped stakes_root are byte-identical, so this mid-stream height introduces no
// real root discontinuity - only the >cap case (the attack) diverges, deterministically.
const SWQ_SOURCE_CAP_ACTIVATION = {
    'BTC:mainnet':  960000,     // Option B: after STATE_COMMITMENT (958500), before STAKE_WEIGHTED_QUORUM (961000)
    'LTC:mainnet':  3143000,    // inert (LTC commits the EMPTY stakes_root; capability staking is BTC-only) - pinned == STATE_COMMITMENT for parity
    'DOGE:mainnet': 6291000,    // inert (DOGE stakes_root empty) - pinned == STATE_COMMITMENT for parity
    'BTC:testnet':  0,          // capped from genesis; STATE_COMMITMENT testnet (145000) > 0, so testnet only ever commits capped roots (no discontinuity)
    'LTC:testnet':  0,
    'DOGE:testnet': 0,
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the capped path end to end
};

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

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
 * DISPENSER fresh-address verdict causality flag-day.
 *
 * dispenser.js decides whether SOURCE may open a dispenser on a GET_ADDRESS it
 * does not own. One of the three admitting conditions is FRESHNESS: the
 * GET_ADDRESS has no prior on-chain activity as of BLOCK_INDEX-1. That verdict
 * lands in the hashed ledger (it decides the DISPENSER action's validity), yet
 * the legacy implementation derives it from a LIVE, OPTIONAL, external HTTP call
 * to the xchain-utxo-tracker (`getFirstSeen`): a node with the tracker reachable
 * and a node without it reach DIFFERENT freshness verdicts over the same block,
 * forking the ledger hash. The tracker is also a different data source entirely
 * (ANY on-chain appearance) than the deterministic chain state every node shares.
 *
 * The fix redefines freshness against INDEXER-LOCAL chain state: fresh = the
 * address has no XChain-tagged activity strictly before BLOCK_INDEX, i.e. no
 * index_addresses row assigned a block_index < BLOCK_INDEX (db.hasXChainActivityBefore;
 * BLOCK_INDEX-1 semantics). index_addresses is the deterministic, id-stable set
 * every node reproduces, so the verdict becomes a pure function of chain state and
 * the external tracker is never consulted for it. Because the redefinition changes
 * which historical DISPENSER creates were valid, it MUST be height-gated: below the
 * activation height the legacy utxo-tracker path runs byte-identically (historical
 * replay preserved); at/after it the local query governs and the tracker is never
 * consulted for this verdict.
 *
 * Gate semantics mirror the sibling causality-gate modules in this repo: keyed on
 * the processing chain's OWN local block_index, '<COIN>:<network>' lookup first,
 * then the bare network key; unknown -> inert/off (legacy tracker path, which
 * preserves deployed behavior).
 *
 * Execution-path gate (an acceptance decision during action processing), NOT a
 * hashing-path change: xchain-sync's BlockHasher reads the already-materialized
 * action rows and never re-runs dispenser validation, so this gate is indexer-only
 * and has no xchain-sync twin.
 *
 * ARMED 2026-07-22. mainnet is gated per coin at the ratified train heights
 * (BTC 961000, LTC 3154250, DOGE 6319000); testnet and regtest are genesis-active
 * (both pre-launch, so every node deploys together and the local path is exercised
 * end to end). The indexer fleet must be deployed before BTC 961000.
 *
 * No backfill concern: below the gate the legacy tracker path still governs, so
 * historical index_addresses.block_index accuracy is irrelevant there; at/after
 * the gate index_addresses.block_index is populated going forward for every
 * address interned during indexing (it is load-bearing for id determinism), so no
 * historical rows need backfilling.
 *
 ********************************************************************/

// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height the indexer-local freshness query governs;
// below it the legacy utxo-tracker getFirstSeen HTTP path runs. ARMED 2026-07-22
// at the ratified deploy-train heights; testnet + regtest genesis-active
// (pre-launch).
const DISPENSER_FRESHNESS_ACTIVATION = {
    'BTC:mainnet':  961000,
    'LTC:mainnet':  3154250,
    'DOGE:mainnet': 6319000,
    testnet: 0,
    regtest: 0,
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Unknown / unarmed -> undefined -> inert/off.
function _activationThreshold(network, coin){
    if(coin != null && DISPENSER_FRESHNESS_ACTIVATION[coin + ':' + network] !== undefined)
        return DISPENSER_FRESHNESS_ACTIVATION[coin + ':' + network];
    return DISPENSER_FRESHNESS_ACTIVATION[network];
}

// Whether the indexer-local dispenser-freshness verdict is in effect at
// `blockIndex` on `network` for `coin`. Below the threshold / unknown chain ->
// off (legacy utxo-tracker path, byte-identical historical replay).
function isDispenserFreshnessLocalActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    DISPENSER_FRESHNESS_ACTIVATION,
    isDispenserFreshnessLocalActive
};

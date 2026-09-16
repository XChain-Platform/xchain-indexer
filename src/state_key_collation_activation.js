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
 * Contract-state `state_key` binary-collation flag-day.
 *
 * The contract_state table is declared CHARSET=utf8 COLLATE=utf8_general_ci
 * (case- AND accent-folding), so the two consensus-facing readers that
 * GROUP BY / ORDER BY `state_key` treat DISTINCT keys a contract legitimately
 * writes (e.g. "Key" vs "key" - the VM's StateManager is Object.create(null)
 * precisely so adversarial keys round-trip) as EQUAL:
 *
 *   1. db.getBlockHashes() / xchain-sync BlockHasher.computeBlockHashes():
 *      the per-block contract-state rows feeding the consensus contract_hash.
 *      Folding GROUP BY collapses collation-equal distinct keys to one group
 *      and keeps only MAX(id), so one written key's latest value is silently
 *      ABSENT from the hash preimage (state that consensus does not cover),
 *      and a snapshot-bootstrapped follower whose physical id assignment
 *      differs can keep the OTHER collision row - divergent contract_hash for
 *      identical history. Every other consensus sort in the same function
 *      already pins a binary collation for exactly this hazard (address
 *      COLLATE utf8_bin, tick COLLATE utf8mb4_bin); state_key was the one
 *      column left folding.
 *   2. db.getContractState(): the VM state reload before EXECUTE. The folding
 *      GROUP BY drops one of two collation-equal keys on reload, so the key
 *      vanishes on the next EXECUTE, contradicting the adversarial-key
 *      round-trip contract of the null-prototype state object.
 *
 * The fix pins `state_key COLLATE utf8_bin` in those GROUP BY / ORDER BY
 * clauses. Binary collation changes both the grouping (collation-colliding
 * keys stop collapsing) and the sort order (case-folded vs binary order) of
 * the contract_hash preimage, and changes what a reloaded contract sees, so
 * an ungated flip re-evaluates already-valid blocks differently and FORKS
 * against deployed nodes. It is therefore height-gated per chain, exactly
 * like state_commitment_activation.js / swq_source_cap_activation.js: below
 * the chain's activation height the legacy folding queries run (historical
 * replay stays byte-identical); at/after it the binary-collation queries run.
 *
 * Gate semantics MIRROR state_commitment_activation.js: keyed on the
 * processing chain's OWN local `block_index`, '<COIN>:<network>' lookup
 * first, then the bare network key; unknown -> inert/off (legacy folding
 * path, which preserves deployed behavior).
 *
 * The byte-identical twin lives in xchain-sync/src/ (BlockHasher is the
 * byte-for-byte conformance pair of getBlockHashes); the xchain-sync twin
 * guard (test/unit/rollback-coverage.test.js) locks the two files equal.
 * BOTH repos must deploy fleet-wide before any armed height is reached.
 *
 ********************************************************************/

const { get, copy, activeAt } = require('./consensus/gate_registry');

const STATE_KEY_COLLATION_ACTIVATION = copy('state_key_collation_activation.STATE_KEY_COLLATION_ACTIVATION');

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key (regtest keeps one key). Unknown -> undefined -> inert/off.
function _activationThreshold(network, coin){
    if(coin != null && STATE_KEY_COLLATION_ACTIVATION[coin + ':' + network] !== undefined)
        return STATE_KEY_COLLATION_ACTIVATION[coin + ':' + network];
    return STATE_KEY_COLLATION_ACTIVATION[network];
}

// Whether the binary `state_key` collation is in effect at `blockIndex` on
// `network` for `coin`. Below the threshold / unknown chain -> off (legacy
// folding queries, byte-identical historical replay).
function isStateKeyBinCollationActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    STATE_KEY_COLLATION_ACTIVATION,
    isStateKeyBinCollationActive
};

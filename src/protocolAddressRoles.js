// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// CONSENSUS-CRITICAL: protocol special-address canonicalization for the block
// hash preimage.
//
// The ledger/actions/contracts hashes (db.js getBlockHashes) hash the RESOLVED
// address strings so the preimage is independent of each node's local id space.
// But the protocol's own special addresses (BURN / GAS / DONATE1 / DONATE2 /
// REWARD) are encoded per chain (a BTC base58 address differs from the LTC and
// DOGE encoding of the same role). When the indexer injects one of these into a
// ledger delta (e.g. an issuance fee credited to DONATE1), the per-chain address
// string leaks into the consensus hash, so the SAME action produces a DIFFERENT
// hash on BTC vs LTC vs DOGE. That breaks the protocol promise that identical
// actions yield an identical consensus hash chain on every chain.
//
// Fix: in the hash preimage ONLY, replace a protocol special address with its
// chain-independent role token. Balances still track the real per-chain address
// (canonicalization touches the hash input, never stored ledger rows). The map
// is GLOBAL (every chain's special addresses, all networks) and applied
// uniformly, so a special address resolves to the same role token regardless of
// which chain is being indexed.
//
// FEE_DESTINATION is intentionally excluded: native-coin fee mode records no
// XCHAIN ledger credit/debit (see utility.js processTransactionFees), so it
// never enters a ledger hash, and it is env-overridable (would defeat a frozen
// map).
//
// xchain-sync/src/BlockHasher.js vendors a byte-identical copy of ROLE_BY_ADDRESS
// and canonicalizeHashAddress; the indexer unit suite asserts this map matches
// src/configs/*.js so config edits can never silently drift the consensus map.

const ROLE_FIELDS = ['BURN', 'GAS', 'DONATE1', 'DONATE2', 'REWARD'];
const COINS       = ['BTC', 'LTC', 'DOGE'];
const NETWORKS    = ['mainnet', 'testnet', 'regtest'];

// Build the address -> role map once from the canonical per-coin configs. Keeping
// it config-derived (rather than a second hardcoded copy) means the indexer can
// never drift from the addresses it actually credits; the frozen snapshot lives
// in xchain-sync, guarded by a cross-repo byte-identity test.
function buildRoleByAddress() {
    const map = {};
    for (const coin of COINS) {
        const cfg = require('./configs/' + coin + '.js');
        for (const network of NETWORKS) {
            const conf = cfg.getConfig(network);
            const addr = (conf && (conf.ADDRESS || conf.address)) || {};
            for (const role of ROLE_FIELDS) {
                const a = addr[role];
                if (a) map[a] = role;
            }
        }
    }
    return map;
}

const ROLE_BY_ADDRESS = buildRoleByAddress();

// Replace a protocol special address with its chain-independent role token for
// hashing; pass any other address (including null) through unchanged.
function canonicalizeHashAddress(address) {
    if (address == null) return address;
    return ROLE_BY_ADDRESS[address] || address;
}

module.exports = { ROLE_BY_ADDRESS, canonicalizeHashAddress, ROLE_FIELDS };

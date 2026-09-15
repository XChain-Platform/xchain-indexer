/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * contract_state_root derivation (SPV sub-tree spec §3 Stage A): the root of
 *
 * Database part: the three reads of the orphan-node observability walk
 * (reportOrphanStats in the persistent SMT part, SPV spec §4.3). Plain functions
 * over the walk's own `query(sql, args)` handle, which the caller binds to a
 * POOLED connection so the walk never shares a block-processing transaction;
 * that contract is the caller's and is restated at the walk.
 *
 * BYTE TWIN: xchain-indexer/src/db/subtree/orphan_stats_reads.js (SOURCE) and
 * xchain-sync/src/db/subtree/orphan_stats_reads.js (FOLLOWER) carry the same
 * bytes, because the walk they serve is the reportOrphanStats block the
 * blockhash conformance suites compare RAW between the two repos. The file
 * requires nothing, so one relative layout serves both repos.
 *
 * Each function hands back the handle's own promise rather than awaiting it, so
 * an await at the call site suspends exactly where the inline statement did.
 *
 ********************************************************************/

'use strict';

// The store's row count, a snapshot separate from the walk: [{ c }].
function countStateTreeNodes(query){
    return query('SELECT COUNT(*) AS c FROM state_tree_nodes', []);
}

// Every distinct root any RETAINED state_tree_roots row still points at, as
// [{ r }]: the union of balances_root, stakes_root and contract_state_root. The
// extension column is NULL on every inert row and IS NOT NULL filters those out,
// so the union is unchanged until a slot arms.
function selectRetainedRootUnion(query, chain, network){
    return query(
        'SELECT DISTINCT balances_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
        'UNION SELECT DISTINCT stakes_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
        'UNION SELECT DISTINCT contract_state_root AS r FROM state_tree_roots WHERE chain=? AND network=? AND contract_state_root IS NOT NULL',
        [chain, network, chain, network, chain, network]);
}

// The rows behind one frontier batch of hashes, resolved in one indexed
// `WHERE node_hash IN (...)` against uq_node_hash: [{ node_hash, left_hash,
// right_hash }] for every hash that has a row. One placeholder per hash, so the
// caller sizes the batch to stay well inside max_allowed_packet and the
// server's prepared-statement placeholder ceiling.
function selectNodeRowsByHash(query, hashes){
    return query(
        'SELECT node_hash, left_hash, right_hash FROM state_tree_nodes WHERE node_hash IN (' +
        hashes.map(() => '?').join(',') + ')', hashes);
}

module.exports = {
    countStateTreeNodes,
    selectRetainedRootUnion,
    selectNodeRowsByHash
};

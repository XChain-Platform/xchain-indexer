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
 * Database part: the state_tree_nodes rows the persistent SMT node store reads
 * and writes (SPV spec §4). Plain functions over a db handle rather than a
 * Database mixin, for the same reason as the state_commitment db parts: the
 * store is driven by unit fakes that implement only doQueryStrict and by the
 * bin/ harnesses, neither of which installs the Database prototype.
 *
 * BYTE TWIN: xchain-indexer/src/db/subtree/node_store_rows.js (SOURCE) and
 * xchain-sync/src/db/subtree/node_store_rows.js (FOLLOWER) carry the same bytes.
 * DbNodeStore, the class these statements serve, is the node-store twin the
 * blockhash conformance suites compare between the two repos, and a row shape or
 * an idempotence rule that differed between the sides would fork the roots the
 * follower rebuilds. The file requires nothing, so one relative layout serves
 * both repos.
 *
 * Every statement is strict (doQueryStrict). A fail-soft [] on the node read is
 * "this subtree is empty", the worst answer the M-17 note at the head of
 * DbNodeStore describes, and a swallowed write is a node missing on a later
 * block. Each function hands back the handle's own promise rather than awaiting
 * it, so an await at the call site suspends exactly where the inline statement
 * did and the split adds no yield point.
 *
 ********************************************************************/

'use strict';

// Rows per multi-row INSERT. Chunked so one statement stays far inside
// max_allowed_packet: 128 rows is 384 bound 64-char hex params, ~25KB on the
// wire against a 16MB default.
const NODE_PUT_CHUNK = 128;

// The internal node stored under one content hash: [{ left_hash, right_hash }],
// or [] when no row exists (an EMPTY constant is never stored, and a hash the
// store never saw has no row either; the caller tells those apart).
function selectNodeRow(db, nodeHashHex){
    return db.doQueryStrict(
        'SELECT left_hash, right_hash FROM state_tree_nodes WHERE node_hash=? LIMIT 1', [nodeHashHex]);
}

// One node row. INSERT IGNORE keeps the write idempotent under the
// content-addressed key: a node re-created by a reorg replay is a no-op.
function insertNodeRow(db, nodeHashHex, leftHex, rightHex){
    return db.doQueryStrict(
        'INSERT IGNORE INTO state_tree_nodes (node_hash, left_hash, right_hash) VALUES (?, ?, ?)',
        [nodeHashHex, leftHex, rightHex]);
}

// One chunk of node rows ({ hash, left, right }) in a single multi-row statement,
// the same rows the single-row form writes one at a time. Duplicate hashes WITHIN
// a chunk are safe by the same INSERT IGNORE rule that makes that form idempotent.
function insertNodeRows(db, chunk){
    const values = new Array(chunk.length).fill('(?, ?, ?)').join(', ');
    const args   = [];
    for(const n of chunk) args.push(n.hash, n.left, n.right);
    return db.doQueryStrict(
        'INSERT IGNORE INTO state_tree_nodes (node_hash, left_hash, right_hash) VALUES ' + values,
        args);
}

module.exports = {
    NODE_PUT_CHUNK,
    selectNodeRow,
    insertNodeRow,
    insertNodeRows
};

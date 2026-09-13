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
 * XChain Indexer - Database mixin: state_tree
 *
 * The queries over state_tree_roots and state_tree_nodes that the retention
 * sweep issues. Installed onto Database.prototype by db/index.js, so call sites
 * stay this.db.<method>().
 *
 * Every method here runs on _poolQuery, NEVER on doQuery, and that is the whole
 * reason they are grouped apart from the block-path state-tree reads. The sweep
 * runs concurrently with block processing on the same Database instance, where
 * getConnection() hands back the open block's transactionConnection; a prune
 * routed through it would join the block's ACID transaction and be committed or
 * rolled back with the block. Phase 2's serialization against the block loop is
 * a mutex the caller holds (runExclusive), not a shared connection.
 *
 ********************************************************************/

module.exports = {

    // Highest block_index with a committed root for this chain, or null when the table
    // holds nothing for it (pre-activation). The retention window is measured down from
    // this, so null means there is nothing to prune rather than "prune everything".
    async getStateTreeRootTip(chain, network){
        const rows = await this.poolQuery(
            'SELECT MAX(block_index) AS tip FROM state_tree_roots WHERE chain=? AND network=?',
            [chain, network]);
        return (rows.length && rows[0].tip != null) ? Number(rows[0].tip) : null;
    },

    // How many root rows sit at or below the retention cutoff, i.e. how many phase 1 would
    // drop. Counting first is what lets the planner report a prune without performing one.
    async countStateTreeRootsAtOrBelow(chain, network, cutoff){
        const rows = await this.poolQuery(
            'SELECT COUNT(*) AS c FROM state_tree_roots WHERE chain=? AND network=? AND block_index <= ?',
            [chain, network, cutoff]);
        return rows.length ? Number(rows[0].c) : 0;
    },

    // Phase 1: drop the block -> root pointers at or below the cutoff and report how many
    // rows went. Node rows are untouched; only the set of heights the SPV proof server can
    // still answer for narrows.
    async deleteStateTreeRootsAtOrBelow(chain, network, cutoff){
        const result = await this.poolQuery(
            'DELETE FROM state_tree_roots WHERE chain=? AND network=? AND block_index <= ?',
            [chain, network, cutoff]);
        return result && result.affectedRows ? Number(result.affectedRows) : 0;
    },

    // Every node in the store, as the (hash, left, right) triples the reachability mark
    // walks. Deliberately unfiltered: the mark has to see the whole store to decide which
    // rows nothing points at.
    async readAllStateTreeNodes(){
        return await this.poolQuery(
            'SELECT node_hash, left_hash, right_hash FROM state_tree_nodes', []);
    },

    // The distinct sub-roots of every RETAINED root row, as rows of { r }.
    //
    // EVERY committed sub-root must appear in this union. Phase 2 DELETES what the mark
    // cannot reach from it, and a missing slot means the sweep reclaims nodes the tree
    // still references; the next incremental descent then reads those absent rows as an
    // EMPTY subtree rather than failing, so the chain keeps running and silently commits a
    // forked root. Adding a slot to merkle.STATE_SUBTREES without adding it here is a
    // data-loss bug that fires only once the slot is armed AND the window rolls past it.
    // contract_state_root is NULL on every inert row and IS NOT NULL drops those, so the
    // union is unchanged until a chain arms the slot.
    async getRetainedStateSubtreeRoots(chain, network){
        return await this.poolQuery(
            'SELECT DISTINCT balances_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
            'UNION SELECT DISTINCT stakes_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
            'UNION SELECT DISTINCT contract_state_root AS r FROM state_tree_roots WHERE chain=? AND network=? AND contract_state_root IS NOT NULL',
            [chain, network, chain, network, chain, network]);
    },

    // How many node rows the store holds. Read BEFORE the mark loads anything, because the
    // mark materializes every row into a Map and an oversized store would exhaust process
    // memory before any post-load size check could fire.
    async countStateTreeNodes(){
        const rows = await this.poolQuery('SELECT COUNT(*) AS c FROM state_tree_nodes', []);
        return rows && rows.length ? Number(rows[0].c) : 0;
    },

    // Phase 2: delete one batch of orphan nodes by hash and report how many went. The
    // caller batches, because the placeholder list is what bounds the statement size.
    async deleteStateTreeNodesByHash(hashes){
        const placeholders = hashes.map(() => '?').join(',');
        const result = await this.poolQuery(
            'DELETE FROM state_tree_nodes WHERE node_hash IN (' + placeholders + ')', hashes);
        return result && result.affectedRows ? Number(result.affectedRows) : 0;
    },

};

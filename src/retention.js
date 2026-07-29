//********************************************************************
//
// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
//********************************************************************
//
// Data-retention / pruning scaffold for the unbounded light-client state
// commitment tables (state_tree_roots + state_tree_nodes). DEFAULT OFF: with
// no retention env var set the module is inert and the current keep-everything
// behavior is byte-for-byte unchanged (nothing is deleted). See
// docs/DATA-RETENTION-POLICY.md for the platform-wide policy this implements
// and the safety argument for the two-phase order.
//
// Two-phase pruning (order is load-bearing):
//   Phase 1  pruneStateRoots   - drop state_tree_roots rows older than the
//                                retention window. This ONLY drops the block ->
//                                root pointers; it never touches the node store.
//                                A pruned block can no longer be served as an
//                                SPV proof root (explorer proof server), which
//                                is the whole point of a retention window.
//   Phase 2  reclaimOrphanNodes - after phase 1, delete state_tree_nodes rows
//                                unreachable from EVERY surviving root. This is
//                                the reclamation that stateCommitment.js
//                                deliberately deferred: it is only safe when it
//                                cannot interleave with forward block-root
//                                insertion, because a content-addressed node
//                                orphaned by a reorg is commonly re-created by
//                                the new canonical chain (INSERT IGNORE no-ops,
//                                the row keeps its id) and deleting it after it
//                                is re-referenced would make the next
//                                incremental _descend read a missing row as an
//                                EMPTY subtree and fork the balances_root. The
//                                caller MUST serialize phase 2 against the block
//                                loop by passing opts.runExclusive (the db
//                                transaction mutex); without it the delete is
//                                unsafe on a live indexer.
//
// Reachability rules here are intentionally identical to
// stateCommitment.reportOrphanStats (EMPTY constants skipped, absent children
// skipped, mark from the UNION of every retained root's balances_root +
// stakes_root). This module is pruning-only and never feeds the consensus hash,
// so it keeps its own copy of the mark rather than modifying the byte-identical
// twin block in stateCommitment.js.

'use strict';

const M = require('./merkle.js');

// Every EMPTY[h] constant, hex. A child hash equal to one of these has no row in
// state_tree_nodes (empty subtrees are never stored), so the mark skips it. Built
// straight from merkle.js so it stays in lockstep with the consensus constants.
const EMPTY_CONSTANTS = (function(){
    const s = new Set();
    for(let h = 0; h <= M.SMT_DEPTH; h++) if(M.EMPTY[h]) s.add(M.toHex(M.EMPTY[h]));
    return s;
})();

// Parse the retention policy from an env-like object. DEFAULT OFF: the policy is
// disabled unless STATE_ROOT_RETENTION_BLOCKS is a positive integer. Node
// reclamation is a strict opt-in ON TOP of an enabled root policy (it is the
// consensus-sensitive half), gated by STATE_NODE_RECLAIM in {1,true}.
//
//   STATE_ROOT_RETENTION_BLOCKS  keep roots for blocks > (tip - N); 0/unset = OFF
//   STATE_NODE_RECLAIM           '1' | 'true' to also reclaim orphan nodes
//   STATE_RETENTION_INTERVAL_MS  sweep cadence (default 6h)
//   STATE_TREE_METRIC_MAX_NODES  reuse the metric cap: skip the in-memory mark
//                                (and thus node reclaim) above this node count
function parseRetentionConfig(env){
    env = env || process.env;
    const rootKeepBlocks = parseInt(env.STATE_ROOT_RETENTION_BLOCKS, 10);
    const enabled = Number.isFinite(rootKeepBlocks) && rootKeepBlocks > 0;
    const reclaimRaw = String(env.STATE_NODE_RECLAIM == null ? '' : env.STATE_NODE_RECLAIM).toLowerCase();
    const nodeReclaimEnabled = enabled && (reclaimRaw === '1' || reclaimRaw === 'true');
    const intervalRaw = parseInt(env.STATE_RETENTION_INTERVAL_MS, 10);
    const maxNodesRaw = parseInt(env.STATE_TREE_METRIC_MAX_NODES, 10);
    return {
        enabled,
        rootKeepBlocks: enabled ? rootKeepBlocks : null,
        nodeReclaimEnabled,
        intervalMs: Number.isFinite(intervalRaw) ? intervalRaw : (6 * 60 * 60 * 1000),
        maxNodes: Number.isFinite(maxNodesRaw) && maxNodesRaw > 0 ? maxNodesRaw : 2000000
    };
}

// Phase 1 planner (read-only). Returns which state_tree_roots rows fall outside
// the retention window without deleting anything. Keeps every root with
// block_index > (tip - rootKeepBlocks); the surviving tip row is always kept so a
// reorg still has its fork-point root to build forward on.
//   { tip, cutoff, prunableCount }   cutoff = highest block_index that WOULD prune
// tip === null means the table is empty (pre-activation): nothing to do.
async function planStateRootPrune(query, chain, network, rootKeepBlocks){
    const tipRows = await query(
        'SELECT MAX(block_index) AS tip FROM state_tree_roots WHERE chain=? AND network=?',
        [chain, network]);
    const tip = (tipRows.length && tipRows[0].tip != null) ? Number(tipRows[0].tip) : null;
    if(tip === null) return { tip: null, cutoff: null, prunableCount: 0 };
    const cutoff = tip - rootKeepBlocks;   // prune rows with block_index <= cutoff
    if(cutoff < 0) return { tip, cutoff: null, prunableCount: 0 };
    const cntRows = await query(
        'SELECT COUNT(*) AS c FROM state_tree_roots WHERE chain=? AND network=? AND block_index <= ?',
        [chain, network, cutoff]);
    const prunableCount = cntRows.length ? Number(cntRows[0].c) : 0;
    return { tip, cutoff, prunableCount };
}

// Phase 1 executor. Drops root pointers older than the window. Safe to run on a
// pooled connection without the apply lock: deleting an old block -> root pointer
// never affects incremental forward processing (which only reads the PRIOR root),
// it only narrows the set of historical roots the SPV proof server can serve.
// Node rows are untouched here; they are reclaimed in phase 2.
async function pruneStateRoots(query, chain, network, cfg){
    if(!cfg || !cfg.enabled) return { skipped: true, deleted: 0 };
    const plan = await planStateRootPrune(query, chain, network, cfg.rootKeepBlocks);
    if(plan.tip === null || plan.cutoff === null || plan.prunableCount === 0)
        return { skipped: false, deleted: 0, tip: plan.tip, cutoff: plan.cutoff };
    const result = await query(
        'DELETE FROM state_tree_roots WHERE chain=? AND network=? AND block_index <= ?',
        [chain, network, plan.cutoff]);
    const deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
    return { skipped: false, deleted, tip: plan.tip, cutoff: plan.cutoff };
}

// Build the reachable-node set from the UNION of every RETAINED state_tree_roots
// row's balances_root + stakes_root + contract_state_root. Identical skip rules
// to stateCommitment.reportOrphanStats. Returns { nodes: Map, reachable: Set }.
//
// EVERY committed sub-root MUST appear in this union, and unlike the
// reportOrphanStats copy that is not an accuracy concern: phase 2 DELETES the
// nodes this set does not reach. A sub-root missing here means the pruner
// reclaims nodes the tree still references, and the next incremental _descend
// reads those missing rows as an EMPTY SUBTREE rather than failing, so the chain
// keeps running and silently commits a forked root. Adding a slot to
// merkle.STATE_SUBTREES without adding it here is therefore a data-loss bug that
// only fires once the slot is armed AND the retention window rolls past it.
// contract_state_root is NULL on every inert row and IS NOT NULL drops those, so
// the union is unchanged until a chain arms the slot.
async function computeReachable(query, chain, network){
    const rows = await query('SELECT node_hash, left_hash, right_hash FROM state_tree_nodes', []);
    const nodes = new Map();
    for(const r of rows) nodes.set(r.node_hash, { l: r.left_hash, r: r.right_hash });

    const rootRows = await query(
        'SELECT DISTINCT balances_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
        'UNION SELECT DISTINCT stakes_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
        'UNION SELECT DISTINCT contract_state_root AS r FROM state_tree_roots WHERE chain=? AND network=? AND contract_state_root IS NOT NULL',
        [chain, network, chain, network, chain, network]);

    const reachable = new Set();
    const stack = [];
    for(const rr of rootRows){
        const root = rr.r;
        if(root && !EMPTY_CONSTANTS.has(root) && nodes.has(root)) stack.push(root);
    }
    while(stack.length){
        const h = stack.pop();
        if(reachable.has(h)) continue;
        reachable.add(h);
        const row = nodes.get(h);
        if(!row) continue;
        for(const child of [row.l, row.r]){
            if(child && !EMPTY_CONSTANTS.has(child) && !reachable.has(child) && nodes.has(child)) stack.push(child);
        }
    }
    return { nodes, reachable };
}

// Phase 2. Reclaim orphan nodes unreachable from every retained root.
//
// SAFETY: the mark and the delete must not interleave with forward block-root
// insertion (see the header). Pass opts.runExclusive = fn => Promise to run the
// whole mark+delete under the block-loop mutex; the wired-in caller
// (XChainIndexer) supplies the db transaction lock. opts.dryRun computes the
// orphan set and returns it WITHOUT deleting (used for planning/observability and
// by the unit tests). Above cfg.maxNodes the in-memory mark is skipped (bounded
// memory), mirroring the orphan metric.
async function reclaimOrphanNodes(query, chain, network, cfg, opts){
    opts = opts || {};
    if(!cfg || !cfg.nodeReclaimEnabled) return { skipped: true, reason: 'disabled', deleted: 0 };

    const doWork = async () => {
        const { nodes, reachable } = await computeReachable(query, chain, network);
        if(nodes.size > cfg.maxNodes)
            return { skipped: true, reason: 'too_many_nodes', totalNodes: nodes.size, deleted: 0 };
        const orphans = [];
        for(const h of nodes.keys()) if(!reachable.has(h)) orphans.push(h);
        const base = { skipped: false, totalNodes: nodes.size, reachable: reachable.size, orphanCount: orphans.length };
        if(orphans.length === 0) return Object.assign(base, { deleted: 0 });
        if(opts.dryRun) return Object.assign(base, { dryRun: true, deleted: 0, orphans });
        let deleted = 0;
        const BATCH = 500;
        for(let i = 0; i < orphans.length; i += BATCH){
            const chunk = orphans.slice(i, i + BATCH);
            const placeholders = chunk.map(() => '?').join(',');
            const result = await query(
                'DELETE FROM state_tree_nodes WHERE node_hash IN (' + placeholders + ')', chunk);
            deleted += result && result.affectedRows ? Number(result.affectedRows) : 0;
        }
        return Object.assign(base, { deleted });
    };

    if(typeof opts.runExclusive === 'function') return opts.runExclusive(doWork);
    return doWork();
}

// One full sweep: phase 1 then phase 2. Node reclaim runs only when opted in AND
// after roots are pruned (so freshly-orphaned nodes are actually collectable).
// The whole sweep is a no-op object when the policy is off.
async function runSweep(query, chain, network, cfg, opts){
    opts = opts || {};
    if(!cfg || !cfg.enabled) return { enabled: false };
    const roots = await pruneStateRoots(query, chain, network, cfg);
    let nodesResult = { skipped: true, reason: 'disabled', deleted: 0 };
    if(cfg.nodeReclaimEnabled) nodesResult = await reclaimOrphanNodes(query, chain, network, cfg, opts);
    return { enabled: true, roots, nodes: nodesResult };
}

module.exports = {
    EMPTY_CONSTANTS,
    parseRetentionConfig,
    planStateRootPrune,
    pruneStateRoots,
    computeReachable,
    reclaimOrphanNodes,
    runSweep
};

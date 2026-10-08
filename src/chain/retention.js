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
// the data-retention page under components/indexer/ in xchain-documentation
// for the platform-wide policy this implements and the safety argument for
// the two-phase order.
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

const M = require('../consensus/merkle.js');
// The default env-like source for parseRetentionConfig: config.js's frozen load-time
// snapshot, the one place this service reads its environment.
const { CONFIG_ENV } = require('../config.js');

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
//   STATE_RETENTION_INTERVAL_MS  sweep cadence (default 6h); a non-positive or
//                                unparseable value falls back to 6h, and the
//                                result is held between 60s and setInterval's max
//   STATE_TREE_METRIC_MAX_NODES  reuse the metric cap: skip the in-memory mark
//                                (and thus node reclaim) above this node count
// STATE_ROOT_RETENTION_BLOCKS is raised to the chain's reorg-safe floor at service
// startup (applyReorgSafeFloor); the parser itself returns the value as configured.
function parseRetentionConfig(env){
    env = env || CONFIG_ENV;
    const rootKeepBlocks = parseInt(env.STATE_ROOT_RETENTION_BLOCKS, 10);
    const enabled = Number.isFinite(rootKeepBlocks) && rootKeepBlocks > 0;
    const reclaimRaw = String(env.STATE_NODE_RECLAIM == null ? '' : env.STATE_NODE_RECLAIM).toLowerCase();
    const nodeReclaimEnabled = enabled && (reclaimRaw === '1' || reclaimRaw === 'true');
    const interval = resolveSweepIntervalMs(env.STATE_RETENTION_INTERVAL_MS);
    const maxNodesRaw = parseInt(env.STATE_TREE_METRIC_MAX_NODES, 10);
    return {
        enabled,
        rootKeepBlocks: enabled ? rootKeepBlocks : null,
        nodeReclaimEnabled,
        intervalMs: interval.intervalMs,
        intervalAdjusted: interval.adjusted,
        maxNodes: Number.isFinite(maxNodesRaw) && maxNodesRaw > 0 ? maxNodesRaw : 2000000
    };
}

const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Shortest sweep cadence accepted. Node clamps a setInterval delay below 1ms (or
// above 2^31-1) to 1ms, and with node reclaim on every sweep holds the block-loop lock.
const MIN_SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_TIMER_DELAY_MS = 2147483647;

// Resolve the sweep cadence: unset keeps the 6h default silently; a non-positive or
// unparseable value falls back to it, and a value outside [60s, 2^31-1] is held to the
// nearer bound. `adjusted` reports any replacement so the caller can warn.
function resolveSweepIntervalMs(raw){
    if(raw == null || raw === '') return { intervalMs: DEFAULT_SWEEP_INTERVAL_MS, adjusted: false };
    const parsed = parseInt(raw, 10);
    if(!Number.isFinite(parsed) || parsed <= 0) return { intervalMs: DEFAULT_SWEEP_INTERVAL_MS, adjusted: true };
    if(parsed < MIN_SWEEP_INTERVAL_MS) return { intervalMs: MIN_SWEEP_INTERVAL_MS, adjusted: true };
    if(parsed > MAX_TIMER_DELAY_MS) return { intervalMs: MAX_TIMER_DELAY_MS, adjusted: true };
    return { intervalMs: parsed, adjusted: false };
}

// The shallowest retention window a chain may run with: the decoder's reorg-safe depth
// (DISPENSER_EXPIRE_SAFE_DEPTH in xchain-decoder's constants.js), the deepest rollback it
// recovers from. Must stay >= the decoder's values; retention.test.js reads them to check.
const ROOT_RETENTION_REORG_FLOOR = 126;
const LTC_TESTNET_ROOT_RETENTION_REORG_FLOOR = 5006;

// Pick the floor with the decoder's own rule: Litecoin testnet is the one deep chain.
function resolveRootRetentionFloor(coin, network){
    return String(coin).toUpperCase() === 'LTC' && String(network).toLowerCase() === 'testnet'
        ? LTC_TESTNET_ROOT_RETENTION_REORG_FLOOR
        : ROOT_RETENTION_REORG_FLOOR;
}

// Raise an enabled window to the chain's floor, so a reorg never rolls back past the
// oldest kept root. Returns a new cfg (floorApplied, requestedRootKeepBlocks); a
// disabled cfg comes back unchanged. Raising only ever keeps more rows.
function applyReorgSafeFloor(cfg, coin, network){
    if(!cfg || !cfg.enabled) return cfg;
    const floor = resolveRootRetentionFloor(coin, network);
    if(cfg.rootKeepBlocks >= floor) return Object.assign({}, cfg, { floorApplied: false });
    return Object.assign({}, cfg, {
        rootKeepBlocks: floor, requestedRootKeepBlocks: cfg.rootKeepBlocks, floorApplied: true
    });
}

// Phase 1 planner (read-only). Returns which state_tree_roots rows fall outside
// the retention window without deleting anything. Keeps every root with
// block_index > (tip - rootKeepBlocks); the surviving tip row is always kept so a
// reorg still has its fork-point root to build forward on.
//   { tip, cutoff, prunableCount }   cutoff = highest block_index that WOULD prune
// tip === null means the table is empty (pre-activation): nothing to do.
async function planStateRootPrune(db, chain, network, rootKeepBlocks){
    const tip = await db.getStateTreeRootTip(chain, network);
    if(tip === null) return { tip: null, cutoff: null, prunableCount: 0 };
    const cutoff = tip - rootKeepBlocks;   // prune rows with block_index <= cutoff
    if(cutoff < 0) return { tip, cutoff: null, prunableCount: 0 };
    const prunableCount = await db.countStateTreeRootsAtOrBelow(chain, network, cutoff);
    return { tip, cutoff, prunableCount };
}

// Phase 1 executor. Drops root pointers older than the window. Safe to run on a
// pooled connection without the apply lock: deleting an old block -> root pointer
// never affects incremental forward processing (which only reads the PRIOR root),
// it only narrows the set of historical roots the SPV proof server can serve.
// Node rows are untouched here; they are reclaimed in phase 2.
async function pruneStateRoots(db, chain, network, cfg){
    if(!cfg || !cfg.enabled) return { skipped: true, deleted: 0 };
    const plan = await planStateRootPrune(db, chain, network, cfg.rootKeepBlocks);
    if(plan.tip === null || plan.cutoff === null || plan.prunableCount === 0)
        return { skipped: false, deleted: 0, tip: plan.tip, cutoff: plan.cutoff };
    const deleted = await db.deleteStateTreeRootsAtOrBelow(chain, network, plan.cutoff);
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
//
// The union itself is db.getRetainedStateSubtreeRoots (src/db/state_tree/index.js),
// which carries the same argument beside the SQL it constrains.
async function computeReachable(db, chain, network){
    const rows = await db.readAllStateTreeNodes();
    const nodes = new Map();
    for(const r of rows) nodes.set(r.node_hash, { l: r.left_hash, r: r.right_hash });

    const rootRows = await db.getRetainedStateSubtreeRoots(chain, network);

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
//
// The cap is checked by COUNT(*) BEFORE computeReachable runs, because the
// post-load nodes.size check bounds nothing: computeReachable materializes every
// state_tree_nodes row into a Map first, so an oversized store exhausts process
// memory before the guard is ever reached. Counting under the same
// runExclusive mutex keeps the count and any subsequent load consistent; the
// nodes.size check below stays as a redundant net.
async function reclaimOrphanNodes(db, chain, network, cfg, opts){
    opts = opts || {};
    if(!cfg || !cfg.nodeReclaimEnabled) return { skipped: true, reason: 'disabled', deleted: 0 };

    const doWork = async () => {
        const preCount = await db.countStateTreeNodes();
        if(preCount > cfg.maxNodes)
            return { skipped: true, reason: 'too_many_nodes', totalNodes: preCount, deleted: 0 };
        const { nodes, reachable } = await computeReachable(db, chain, network);
        if(nodes.size > cfg.maxNodes)
            return { skipped: true, reason: 'too_many_nodes', totalNodes: nodes.size, deleted: 0 };
        const orphans = [];
        for(const h of nodes.keys()) if(!reachable.has(h)) orphans.push(h);
        const base = { skipped: false, totalNodes: nodes.size, reachable: reachable.size, orphanCount: orphans.length };
        if(orphans.length === 0) return Object.assign(base, { deleted: 0 });
        if(opts.dryRun) return Object.assign(base, { dryRun: true, deleted: 0, orphans });
        let deleted = 0;
        const BATCH = 500;
        for(let i = 0; i < orphans.length; i += BATCH)
            deleted += await db.deleteStateTreeNodesByHash(orphans.slice(i, i + BATCH));
        return Object.assign(base, { deleted });
    };

    if(typeof opts.runExclusive === 'function') return opts.runExclusive(doWork);
    return doWork();
}

// One full sweep: phase 1 then phase 2. Node reclaim runs only when opted in AND
// after roots are pruned (so freshly-orphaned nodes are actually collectable).
// The whole sweep is a no-op object when the policy is off.
async function runSweep(db, chain, network, cfg, opts){
    opts = opts || {};
    if(!cfg || !cfg.enabled) return { enabled: false };
    const roots = await pruneStateRoots(db, chain, network, cfg);
    let nodesResult = { skipped: true, reason: 'disabled', deleted: 0 };
    if(cfg.nodeReclaimEnabled) nodesResult = await reclaimOrphanNodes(db, chain, network, cfg, opts);
    return { enabled: true, roots, nodes: nodesResult };
}

module.exports = {
    EMPTY_CONSTANTS,
    parseRetentionConfig,
    resolveSweepIntervalMs,
    MIN_SWEEP_INTERVAL_MS,
    ROOT_RETENTION_REORG_FLOOR,
    LTC_TESTNET_ROOT_RETENTION_REORG_FLOOR,
    resolveRootRetentionFloor,
    applyReorgSafeFloor,
    planStateRootPrune,
    pruneStateRoots,
    computeReachable,
    reclaimOrphanNodes,
    runSweep
};

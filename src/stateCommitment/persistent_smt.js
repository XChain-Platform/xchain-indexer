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
 * Light-client state commitment: the persistent node store and SMT engine
 * (SPV spec §4), the part of stateCommitment.js that xchain-sync carries as
 * BYTE twins.
 *
 * Three regions of this file are the consensus contract with the follower
 * (xchain-sync/src/stateCommitment.js keeps its own copy of each), and the sync
 * conformance suite test/unit/blockhash_conformance_twin.test.js reads them out
 * of THIS path by their markers and signatures: the DbNodeStore/MemoryNodeStore
 * block, PersistentSMT's update/buildFull/prove (raw bytes) with descend and
 * putBatch equal modulo the declared node cache, and the reportOrphanStats
 * block with its header comment. The platform frozen-twin registry declares the
 * same three blocks against this path. An edit inside any of them is a paired
 * window with xchain-sync, never a one-sided change.
 *
 * What lives here and why it is one file: the node store defines what a row IS,
 * the engine is the only reader and writer of those rows, and the orphan walk
 * counts them. The per-block orchestration that drives the engine stays in
 * src/stateCommitment.js, which requires this part and re-exports its classes
 * so every existing requirer keeps its import.
 *
 * Node model (consensus-critical):
 *   - The store holds INTERNAL nodes only, keyed by node_hash, row {left_hash, right_hash}.
 *   - A value leaf (depth 256) is never its own row; it lives as a child hash of its
 *     depth-255 parent.
 *   - Empty subtrees are the EMPTY[h] constants from merkle.js and are NEVER stored;
 *     a child hash that is an EMPTY constant simply has no row of its own.
 *   - At depth d a node covers a subtree of height (256-d); its EMPTY constant is
 *     EMPTY[256-d], and the sibling at depth d covers height (255-d) => EMPTY[255-d]
 *     (matching merkle.js compressSmtProof / verifySmtProof indexing).
 *
 ********************************************************************/

'use strict';

const M = require('../consensus/merkle.js');

const EMPTY_ROOT_HEX = M.toHex(M.EMPTY_SMT_ROOT);   // root of an empty depth-256 SMT
const EMPTY0_HEX     = M.toHex(M.EMPTY[0]);

// ---- Node stores ------------------------------------------------------------
// Interface: async get(nodeHashHex) -> { left_hash, right_hash } | null ;
//            async put(nodeHashHex, leftHex, rightHex) -> void  (idempotent / INSERT IGNORE)
//            async putMany(nodes) -> void  (OPTIONAL fast path: same rows, one
//                                            statement per chunk)
//
// putMany is optional because stores are DECORATED as well as implemented: the
// bench harness in bin/ wraps an inner store to instrument put, and the subtree
// unit tests hand in bare {get, put} fakes. Requiring it would break every one of
// them at a call site far from the edit. PersistentSMT.putBatch is the single
// place that chooses, and the fallback writes the identical rows in the identical
// order, so a store without it is slow, never wrong.
//
// putMany exists because ONE key update writes SMT_DEPTH internal nodes and a
// value leaf's ancestors are never an empty subtree, so the write loop is always
// a full 256 rows. Issued one statement at a time that is 256 sequential round
// trips per key, which on the BTC regtest venue (49 stake keys rebuilt from an
// empty root every block) is 12,544 round trips and 25-66s of wall clock per
// block against LTC's 3-5s, failing five standing envelope tests as timeouts.
// The rows written are identical either way; only the statement count changes, so
// this is a transport fix and not a consensus one.

// MariaDB-backed content-addressed store over `state_tree_nodes`.
//
// M-17: every read and write in this file uses doQueryStrict. doQuery collapses
// a NON-transactional query error into [], and inside a transaction the two are
// identical, so this changes nothing on the block path. It changes the paths
// that run WITHOUT a transaction (seedSnapshotRoots on the follower, and the
// bin/ harnesses), where a fail-soft [] is not an error signal but a meaningful
// and WRONG answer:
//
//   DbNodeStore.get -> [] is "this subtree is empty", so descend keeps
//     building against a truncated tree and emits a root that looks perfectly
//     valid. This is the worst of the set: nothing downstream can detect it.
//   DbNodeStore.put -> a swallowed write means the node is missing on a LATER
//     block, which then reads as an empty subtree by the same route.
//   buildFullBalancesRoot -> [] commits EMPTY_ROOT over a populated ledger.
//   the prior-root read -> [] degrades to a full rebuild: correct, expensive,
//     and strict anyway so no read here is left soft for a later edit to move.
//
// getNetBalance was already loud by accident (it indexes rows[0]); it is strict
// now by intent rather than by luck.
const DB_NODE_PUT_CHUNK = 128;

class DbNodeStore {
    constructor(db){ this.db = db; }
    async get(nodeHashHex){
        const rows = await this.db.doQueryStrict(
            'SELECT left_hash, right_hash FROM state_tree_nodes WHERE node_hash=? LIMIT 1', [nodeHashHex]);
        return rows.length ? rows[0] : null;
    }
    async put(nodeHashHex, leftHex, rightHex){
        await this.db.doQueryStrict(
            'INSERT IGNORE INTO state_tree_nodes (node_hash, left_hash, right_hash) VALUES (?, ?, ?)',
            [nodeHashHex, leftHex, rightHex]);
    }
    // Chunked so one statement stays far inside max_allowed_packet: 128 rows is
    // 384 bound 64-char hex params, ~25KB on the wire against a 16MB default.
    // Duplicate hashes WITHIN a chunk are safe by the same INSERT IGNORE rule
    // that makes the single-row form idempotent.
    async putMany(nodes){
        for(let i = 0; i < nodes.length; i += DB_NODE_PUT_CHUNK){
            const chunk  = nodes.slice(i, i + DB_NODE_PUT_CHUNK);
            const values = new Array(chunk.length).fill('(?, ?, ?)').join(', ');
            const args   = [];
            for(const n of chunk) args.push(n.hash, n.left, n.right);
            await this.db.doQueryStrict(
                'INSERT IGNORE INTO state_tree_nodes (node_hash, left_hash, right_hash) VALUES ' + values,
                args);
        }
    }
}

// In-memory store: used by the unit fuzz test and any caller that wants a
// throwaway tree. Same interface as DbNodeStore.
class MemoryNodeStore {
    constructor(){ this.map = new Map(); }
    async get(nodeHashHex){ return this.map.has(nodeHashHex) ? this.map.get(nodeHashHex) : null; }
    async put(nodeHashHex, leftHex, rightHex){
        if(!this.map.has(nodeHashHex)) this.map.set(nodeHashHex, { left_hash: leftHex, right_hash: rightHex });
    }
    async putMany(nodes){
        for(const n of nodes) await this.put(n.hash, n.left, n.right);
    }
    get size(){ return this.map.size; }
}

// ---- Persistent SMT engine --------------------------------------------------
// Node-cache bound. Each entry is one 64-char hash key plus two 64-char child
// hashes, so ~200k entries is a few hundred MB of heap worst case and the
// engine degrades to plain store reads past it rather than growing without
// limit. Every PersistentSMT is constructed function-locally (four sites in
// this file, all inside one block's work), so the cache dies with the call.
const SMT_NODE_CACHE_MAX = 200000;

class PersistentSMT {
    // opts.nodeCacheMax = 0 disables the cache entirely (the uncached reference
    // run the read-count regression test needs).
    constructor(store, opts){
        this.store         = store;
        this._nodeCacheMax = (opts && opts.nodeCacheMax != null) ? opts.nodeCacheMax : SMT_NODE_CACHE_MAX;
        this._nodeCache    = new Map();
    }

    // Read-through cache over the content-addressed node rows. The WRITE half of
    // this shape was already fixed (see the putMany header above); the read half
    // still cost one dependent round trip per level, and a present key never
    // short-circuits, so every descent was a full SMT_DEPTH of them: once in
    // update() and again in the prove() that assertCommittedLeaves runs over the
    // same keys, plus SMT_DEPTH per key on the buildFull rebuild paths.
    //
    // Three properties keep this a transport fix and not a consensus one:
    //   1. POSITIVE ENTRIES ONLY. A store miss is never cached. Absence is the
    //      fail-loud signal the M-17 strict-read note above is about, and it must
    //      keep reaching the store every time it is asked.
    //   2. CONTENT-ADDRESSED KEYS. node_hash = H(left||right), so a row's value can
    //      never change under its key and a cached entry cannot go stale. A row a
    //      concurrent retention sweep deleted still answers with the same children.
    //   3. INSTANCE-SCOPED, BOUNDED. Never module-scoped: the cache cannot outlive
    //      the block's work, so a rolled-back transaction discards it wholesale.
    // A miss falls through to the identical store.get, so no root can move.
    cacheGet(hashHex){
        return this._nodeCacheMax > 0 ? this._nodeCache.get(hashHex) : undefined;
    }
    cachePut(hashHex, leftHex, rightHex){
        if(this._nodeCacheMax <= 0 || this._nodeCache.has(hashHex)) return;
        // FIFO eviction over Map insertion order. Nodes are offered leaf-first by
        // putBatch, so the oldest entry is the deepest and least re-read.
        if(this._nodeCache.size >= this._nodeCacheMax)
            this._nodeCache.delete(this._nodeCache.keys().next().value);
        this._nodeCache.set(hashHex, { left_hash: leftHex, right_hash: rightHex });
    }

    // Descend a key's path collecting the 256 siblings (hex, top-down). Returns
    // { siblings, oldLeaf } where oldLeaf is the current value leaf at the key
    // (EMPTY[0] hex if absent). Empty subtrees short-circuit: once a node has no
    // row it is an EMPTY constant and every remaining sibling is the EMPTY for
    // that level.
    async descend(rootHex, keyBuf){
        const siblings = new Array(M.SMT_DEPTH);
        let cur = rootHex;
        let empty = false;
        for(let d = 0; d < M.SMT_DEPTH; d++){
            const sibEmptyHex = M.toHex(M.EMPTY[M.SMT_DEPTH - 1 - d]);
            if(empty){ siblings[d] = sibEmptyHex; continue; }
            let row = this.cacheGet(cur);
            if(row === undefined){
                row = await this.store.get(cur);
                if(row) this.cachePut(cur, row.left_hash, row.right_hash);
            }
            if(!row){ empty = true; siblings[d] = sibEmptyHex; continue; }
            const bit = M.bitAt(keyBuf, d);
            siblings[d] = (bit === 0) ? row.right_hash : row.left_hash;
            cur         = (bit === 0) ? row.left_hash  : row.right_hash;
        }
        return { siblings, oldLeaf: empty ? EMPTY0_HEX : cur };
    }

    // Persist a path's nodes, preferring the store's batch write. The fallback
    // is the pre-batch behaviour and exists only for stores that predate
    // putMany (bare {get, put} fakes and the bin/ instrumentation decorator);
    // it writes the same rows in the same order at one round trip each.
    async putBatch(nodes){
        if(typeof this.store.putMany === 'function'){
            await this.store.putMany(nodes);
        } else {
            for(const n of nodes) await this.store.put(n.hash, n.left, n.right);
        }
        // Seed the read cache only AFTER the write resolved, so a throwing
        // doQueryStrict never leaves an entry claiming a row that is not durable.
        // This is where most of the win is: update() threads its new root into the
        // next descend, and assertCommittedLeaves proves the same keys back
        // against the final root, so these nodes are re-read within the same call.
        for(const n of nodes) this.cachePut(n.hash, n.left, n.right);
    }

    // Set (leafHex) or delete (null) a key, persisting new internal nodes. Returns
    // the new root hex. Apply keys sequentially: each call threads the updated root
    // so shared-prefix keys see prior inserts.
    async update(rootHex, keyBuf, newLeafHexOrNull){
        const { siblings } = await this.descend(rootHex, keyBuf);
        let cur = (newLeafHexOrNull == null) ? EMPTY0_HEX : newLeafHexOrNull;
        // Collect the path's nodes and write them in ONE batch after the climb
        // rather than a round trip per level. Deferring is safe because
        // the climb reads NOTHING: every parent is hashed from `cur` and the
        // sibling already captured by descend, so no node written here is read
        // back before the flush. The flush is inside update() and not hoisted to
        // buildFull for exactly that reason in reverse: the NEXT update() descends
        // the root this one returns, so its nodes must be durable by then.
        const pending = [];
        for(let d = M.SMT_DEPTH - 1; d >= 0; d--){
            const bit  = M.bitAt(keyBuf, d);
            const sib  = siblings[d];
            const left  = (bit === 0) ? cur : sib;
            const right = (bit === 0) ? sib : cur;
            const parent = M.toHex(M.nodeHash(left, right));
            // Skip storing an all-empty subtree: its hash is an EMPTY constant with no row.
            if(parent !== M.toHex(M.EMPTY[M.SMT_DEPTH - d]))
                pending.push({ hash: parent, left, right });
            cur = parent;
        }
        if(pending.length) await this.putBatch(pending);
        return cur;
    }

    // Build a fresh tree from a full leaf set (key hex -> leaf hex). Used for the
    // flag-day initialization and the (small) BTC stakes subtree.
    async buildFull(entries){
        let root = EMPTY_ROOT_HEX;
        for(const [keyHex, leafHex] of entries)
            root = await this.update(root, M.toBuf(keyHex), leafHex);
        return root;
    }

    // Membership / non-membership proof as-of a given root (same shape as
    // merkle.js SparseMerkleTree.prove; verify with M.verifyCompressedSmtProof).
    async prove(rootHex, keyBuf){
        const { siblings, oldLeaf } = await this.descend(rootHex, keyBuf);
        const present = (oldLeaf !== EMPTY0_HEX);
        return {
            key:        M.toHex(keyBuf),
            leaf_value: present ? oldLeaf : null,
            siblings,
            compressed: M.compressSmtProof(siblings)
        };
    }
}

// Every EMPTY[h] constant, hex. A child hash equal to one of these has no row in
// state_tree_nodes (empty subtrees are never stored), so reachability marking skips it.
const EMPTY_CONSTANTS = (function(){
    const s = new Set();
    for(let h = 0; h <= M.SMT_DEPTH; h++) if(M.EMPTY[h]) s.add(M.toHex(M.EMPTY[h]));
    return s;
})();

// ---- Orphan-node observability (read-only; SPV spec §4.3) -------------------
// TWIN PAIR: xchain-indexer/src/stateCommitment.js and xchain-sync/src/
// stateCommitment.js each carry this comment + function; keep the whole block
// BYTE-IDENTICAL, comments included (drift-guarded in both repos by
// test/unit/blockhash-conformance-twin.test.js).
//
// Reports total vs reachable internal nodes in the content-addressed COW
// state_tree_nodes store so unbounded growth (reorg orphans + per-block stake-
// subtree buildFull churn) is measurable. Reachability marks from the UNION of
// EVERY retained state_tree_roots row's balances_root + stakes_root +
// contract_state_root: the explorer SPV proof server descends historical roots,
// so a node is live if ANY retained root reaches it. The extension column is
// NULL on every inert row and IS NOT NULL filters those out, so the union is
// unchanged until a slot arms; leaving it out instead would under-report
// reachability the moment one does, which is a reporting bug now and a
// correctness trap for any future sweep that trusts these numbers.
//
// Marks by a BATCHED FRONTIER WALK and never materializes the node table. Heap
// holds one hash per seen node plus the current batch, so it tracks the
// REACHABLE set rather than the whole store, and only reachable rows are read at
// all. Each frontier level resolves in one indexed `WHERE node_hash IN (...)`
// against uq_node_hash, capping round trips at ceil(maxNodes / batchSize); every
// one of those takes and releases its own pooled connection, so nothing is held
// across the walk. Mark semantics are unchanged from the in-memory DFS this
// replaced: a hash counts as reachable only when the store actually returned a
// row for it, EMPTY constants are skipped, and each hash is expanded once.
//
// Past maxNodes seen hashes the walk stops instead of growing without bound and
// sets reachabilityEstimated, which makes reachableNodes a LOWER bound and
// orphanCount an UPPER bound. totalNodes is the COUNT(*), a snapshot separate
// from the walk, so a concurrent insert can move the two apart by a few rows.
// This function is observability only and never feeds a consensus hash, so both
// that skew and a truncated estimate are acceptable here.
//
// Deliberately does NOT delete. A safe reclaiming sweep must serialize against
// block-root insertion: a content-addressed node orphaned by a reorg is commonly
// re-created by the new canonical chain (INSERT IGNORE is a no-op, the row keeps
// its old id), and deleting it after it is re-referenced would make the next
// incremental _descend read a missing row as an EMPTY subtree and fork the
// balances_root. Reclamation is deferred to a dedicated design paired with
// root-retention pruning (which is what would actually free the bulk that
// retained historical roots otherwise pin).
//
// `query(sql, args)` MUST run on a POOLED (non-transaction) connection so this
// never shares the caller's block-processing/apply transaction. Returns
// { totalNodes, reachableNodes, orphanCount, reachabilitySkipped }, plus
// reachabilityEstimated: true when the walk stopped at the cap.
async function reportOrphanStats(query, chain, network, opts){
    opts = opts || {};
    const maxNodes  = opts.maxNodes  || parseInt(process.env.STATE_TREE_METRIC_MAX_NODES, 10) || 2000000;
    // One placeholder per hash, so the batch must stay well inside max_allowed_packet
    // and the server's prepared-statement placeholder ceiling; 1000 CHAR(64) hashes is
    // ~66KB of SQL text and one uq_node_hash range scan.
    const batchSize = opts.batchSize || 1000;
    const cnt = await query('SELECT COUNT(*) AS c FROM state_tree_nodes', []);
    const totalNodes = cnt.length ? Number(cnt[0].c) : 0;
    if(totalNodes === 0) return { totalNodes: 0, reachableNodes: 0, orphanCount: 0, reachabilitySkipped: false };

    const rootRows = await query(
        'SELECT DISTINCT balances_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
        'UNION SELECT DISTINCT stakes_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
        'UNION SELECT DISTINCT contract_state_root AS r FROM state_tree_roots WHERE chain=? AND network=? AND contract_state_root IS NOT NULL',
        [chain, network, chain, network, chain, network]);

    // `seen` holds every hash queued or resolved and doubles as the dedupe guard, so
    // no hash is queried or expanded twice; reachableNodes counts only hashes the
    // store returned a row for, which is what the old in-memory `nodes.has(...)`
    // guards enforced. A queued hash with no row is simply never counted, which is
    // the normal case for the value leaf under a depth-255 node (leaves are not rows,
    // SPV spec §4.1): seen therefore runs to reachable + reachable leaves, still O(1)
    // per node and still what maxNodes is bounding, since seen IS the heap.
    const seen = new Set();
    let frontier = [];
    for(const rr of rootRows){
        const root = rr.r;
        if(root && !EMPTY_CONSTANTS.has(root) && !seen.has(root)){ seen.add(root); frontier.push(root); }
    }
    let reachableNodes = 0;
    let truncated = false;
    while(frontier.length){
        if(seen.size > maxNodes){ truncated = true; break; }
        const batch = frontier.splice(0, batchSize);
        const rows = await query(
            'SELECT node_hash, left_hash, right_hash FROM state_tree_nodes WHERE node_hash IN (' +
            batch.map(() => '?').join(',') + ')', batch);
        for(const row of rows){
            reachableNodes++;
            for(const child of [row.left_hash, row.right_hash]){
                if(child && !EMPTY_CONSTANTS.has(child) && !seen.has(child)){ seen.add(child); frontier.push(child); }
            }
        }
    }
    const stats = { totalNodes, reachableNodes, orphanCount: totalNodes - reachableNodes, reachabilitySkipped: false };
    if(truncated) stats.reachabilityEstimated = true;
    return stats;
}

module.exports = {
    EMPTY_ROOT_HEX,
    DbNodeStore,
    MemoryNodeStore,
    PersistentSMT,
    reportOrphanStats
};

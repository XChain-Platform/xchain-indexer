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
 * Light-client state commitment: persistent, incremental SMT (SPV spec §4).
 *
 * The in-memory SparseMerkleTree in merkle.js is the reference shape (rebuilds a
 * root from the full leaf Map). This module is the PERSISTENT, INCREMENTAL twin
 * that must produce byte-identical roots from a content-addressed copy-on-write
 * node store (`state_tree_nodes`). The golden vectors + the persistent-vs-reference
 * fuzz test (test/unit/stateCommitment.test.js) lock the equality; the xchain-sync
 * follower keeps its own byte-identical copy and HALTS on divergence.
 *
 * The derivations the block commitment composes live beside this file as named
 * parts: stateCommitment/ holds the leaf values, stakes_root, state_root and
 * block_merkle_root, the full balances build and the two completeness guards;
 * db/state_commitment/ holds the ledger reads. What stays here is the node-store
 * and SMT engine, the orphan observability twin block, and the per-block
 * orchestration whose source the frozen twin suites and the flag-day deploy
 * check read by this path.
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

const M = require('./consensus/merkle.js');
const SUB = require('./state_subtree_activation.js');
const CST = require('./consensus/contract_state_subtree.js');
const ESC = require('./consensus/escrow_leaf_subtree.js');
const EJW = require('./consensus/escrowJournalWriter.js');   // SOURCE ONLY: the follower replicates these rows
const { getLogger } = require('./observability/index.js');
const { leafOrNull } = require('./stateCommitment/leaf_values.js');
const { gatherStakeEntries, buildStakesRoot, resetStakesMemo } = require('./stateCommitment/stakes_root.js');
const { assembleStateRoot, extraSubRootColumn, computeBlockMerkleRoot } = require('./stateCommitment/state_root.js');
const FULL = require('./stateCommitment/full_balances_root.js');
const { enforceTouchedSet, assertCommittedLeaves } = require('./stateCommitment/touch_guards.js');
const { getNetBalance } = require('./db/state_commitment/ledger_reads.js');

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
// them at a call site far from the edit. PersistentSMT._putBatch is the single
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
//   DbNodeStore.get -> [] is "this subtree is empty", so _descend keeps
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
    // update() and again in the prove() that _assertCommittedLeaves runs over the
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
    _cacheGet(hashHex){
        return this._nodeCacheMax > 0 ? this._nodeCache.get(hashHex) : undefined;
    }
    _cachePut(hashHex, leftHex, rightHex){
        if(this._nodeCacheMax <= 0 || this._nodeCache.has(hashHex)) return;
        // FIFO eviction over Map insertion order. Nodes are offered leaf-first by
        // _putBatch, so the oldest entry is the deepest and least re-read.
        if(this._nodeCache.size >= this._nodeCacheMax)
            this._nodeCache.delete(this._nodeCache.keys().next().value);
        this._nodeCache.set(hashHex, { left_hash: leftHex, right_hash: rightHex });
    }

    // Descend a key's path collecting the 256 siblings (hex, top-down). Returns
    // { siblings, oldLeaf } where oldLeaf is the current value leaf at the key
    // (EMPTY[0] hex if absent). Empty subtrees short-circuit: once a node has no
    // row it is an EMPTY constant and every remaining sibling is the EMPTY for
    // that level.
    async _descend(rootHex, keyBuf){
        const siblings = new Array(M.SMT_DEPTH);
        let cur = rootHex;
        let empty = false;
        for(let d = 0; d < M.SMT_DEPTH; d++){
            const sibEmptyHex = M.toHex(M.EMPTY[M.SMT_DEPTH - 1 - d]);
            if(empty){ siblings[d] = sibEmptyHex; continue; }
            let row = this._cacheGet(cur);
            if(row === undefined){
                row = await this.store.get(cur);
                if(row) this._cachePut(cur, row.left_hash, row.right_hash);
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
    async _putBatch(nodes){
        if(typeof this.store.putMany === 'function'){
            await this.store.putMany(nodes);
        } else {
            for(const n of nodes) await this.store.put(n.hash, n.left, n.right);
        }
        // Seed the read cache only AFTER the write resolved, so a throwing
        // doQueryStrict never leaves an entry claiming a row that is not durable.
        // This is where most of the win is: update() threads its new root into the
        // next descend, and _assertCommittedLeaves proves the same keys back
        // against the final root, so these nodes are re-read within the same call.
        for(const n of nodes) this._cachePut(n.hash, n.left, n.right);
    }

    // Set (leafHex) or delete (null) a key, persisting new internal nodes. Returns
    // the new root hex. Apply keys sequentially: each call threads the updated root
    // so shared-prefix keys see prior inserts.
    async update(rootHex, keyBuf, newLeafHexOrNull){
        const { siblings } = await this._descend(rootHex, keyBuf);
        let cur = (newLeafHexOrNull == null) ? EMPTY0_HEX : newLeafHexOrNull;
        // Collect the path's nodes and write them in ONE batch after the climb
        // rather than a round trip per level. Deferring is safe because
        // the climb reads NOTHING: every parent is hashed from `cur` and the
        // sibling already captured by _descend, so no node written here is read
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
        if(pending.length) await this._putBatch(pending);
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
        const { siblings, oldLeaf } = await this._descend(rootHex, keyBuf);
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

// Candidate reserved sub-roots for one block, before gating. Stage A's
// contract_state_root is derived here (contractStateSubtree.js, byte-identical
// across the twins); Stage B's escrow leaf is not a slot and does not appear.
// This is the single seam all three block paths share, which is why arming a
// slot stays a height change plus this function rather than a re-plumb of the
// commit path.
//
// The isSubtreeActive check below is a COST guard, NOT the consensus gate.
// gateSubRoots remains the only thing that decides what enters state_root, and
// it re-checks. This early return exists so that while every map is empty the
// fleet issues ZERO additional queries per block, which is what makes "nothing
// changes until a height is armed" provable by inspection instead of argued
// from the gate's behaviour. Do not delete gateSubRoots on the strength of it.
//
// Deriving BELOW an armed height (spec §7's shadow-compute window, where the
// candidate is computed and stored but not committed) is a deliberate future
// change to this one condition, and it is safe precisely because the column
// read is gated separately.
async function reservedSubRootCandidates(db, chain, network, blockIndex){
    if(!SUB.isSubtreeActive('contract_state_root', blockIndex, network, chain)) return null;
    const smt = new PersistentSMT(new DbNodeStore(db));
    return { contract_state_root: await CST.resolveContractStateRoot(db, smt, chain, network, blockIndex, false) };
}

// Shadow-compute window (spec §7 step 1): the WOULD-BE sub-roots at a height where
// the slot is NOT committed. Returned separately from the candidates above and
// never handed to gateSubRoots, so there is no path by which a shadow value can
// reach state_root; it is persisted to its own column for cross-twin comparison.
// Null while nothing is shadowing, which is the fleet's state today, and the same
// zero-query rule applies: an inert chain does not read contract_state at all.
async function shadowSubRoots(db, chain, network, blockIndex){
    if(!SUB.isSubtreeShadowActive('contract_state_root', blockIndex, network, chain)) return null;
    const smt = new PersistentSMT(new DbNodeStore(db));
    return { contract_state_root: await CST.resolveContractStateRoot(db, smt, chain, network, blockIndex, true) };
}

// The full balances_root build (stateCommitment/full_balances_root.js) over a
// fresh PersistentSMT on this db's node store. The engine lives in this file, so
// the part takes it as an argument instead of requiring it back from here.
async function buildFullBalancesRoot(db, chain, network, blockIndex, opts){
    const smt = new PersistentSMT(new DbNodeStore(db));
    return FULL.buildFullBalancesRootWith(smt, db, chain, network, blockIndex, opts);
}

// ---- Orchestrator -----------------------------------------------------------
// Compute + persist the per-block roots, INSIDE the block transaction (the caller
// runs this after sanityCheck, before commit). chain = COIN, network = NETWORK.
// Each step below keeps the order the roots have always been derived and
// written in: escrow journal, balances_root, stakes_root, then the assembled
// state_root and the row.
async function computeAndStoreRoots(db, chain, network, blockIndex, isActivationBlock){
    const smt = new PersistentSMT(new DbNodeStore(db));

    const { escShadow, armingBlock } = await writeEscrowJournalForBlock(db, chain, network, blockIndex);
    const { balancesRoot, shadowBalanceUpdates } = await balancesRootForBlock(
        db, smt, chain, network, blockIndex, isActivationBlock, armingBlock, escShadow);

    // stakes_root: BTC-only; LTC/DOGE commit the empty-SMT root.
    let stakesRoot = EMPTY_ROOT_HEX;
    if(chain === 'BTC'){
        const stakeEntries = await gatherStakeEntries(db, blockIndex);
        stakesRoot = await buildStakesRoot(smt, chain, network, blockIndex, stakeEntries);
    }

    const roots = await storeBlockRoots(db, smt, chain, network, blockIndex,
        { balancesRoot, stakesRoot, escShadow, shadowBalanceUpdates });

    // Bound the touched-key name memos to ONE block. db._smtAddressNameCache and
    // db._smtTickNameCache are filled ONLY under the _smtTouched choke point
    // (db.createLedgerChangeRecord), and XChainIndexer installs a fresh _smtTouched per
    // block, but nothing dropped the memos on a SUCCESSFUL commit: only rollbackTransaction
    // and the reorg path in rollback.js did. An uninterrupted indexer therefore retained one
    // entry per distinct address and ticker it had ever touched, so resident size tracked the
    // cumulative address/ticker population instead of per-block work.
    //
    // Clearing HERE, at the end of the per-block root computation, gives the memos exactly
    // the lifetime of the touched set they serve: this runs after sanityCheck and after every
    // ledger write of the block, and a block that never reaches this point is rolled back,
    // which clears them on the existing path. Refill is lazy and STRICT (doQueryStrict), so
    // the only cost is one indexed primary-key read per distinct touched id per block and no
    // value can change. Guarded because computeAndStoreRoots is also driven by unit mocks
    // that implement only the query surface.
    if(typeof db.clearSmtNameCaches === 'function') db.clearSmtNameCaches();

    return roots;
}

// escrow_leaf_journal (Stage B), SOURCE ONLY. This runs BEFORE the roots are
// computed so the derivation below sees this block's rows, and it has no
// counterpart in computeFollowerRoots: the follower REPLICATES these rows
// rather than deriving them, which is what keeps the attribution rules (the
// nine recipient-keyed release sites re-keyed to their locker) from having
// to exist twice and agree byte-for-byte. The writer derives each key's
// total from the block's own escrows LEDGER rows, never from family
// aggregates or status predicates (see escrowJournalWriter.js for why).
//
// The ARMING BLOCK gets a full-history replay of the escrows ledger instead
// of this block's rows. That is what lets the leaf arm with no operational
// backfill: the replay lands as ordinary journal rows, replicates, and both
// twins then full-build from the journal exactly as on any other block.
// Without it the arming block would commit a balances_root with no locked
// leaves at all on a chain that has open positions, which is a silent fork.
// The writer also runs through a §7 SHADOW window (consensus-free: the
// journal is not a commitment, and its rows replicate to the follower
// exactly as when armed, which is what lets the window exercise writer,
// replication and application end to end). Full-pass triggers, each a
// one-shot: the true ARMING block always replays the whole ledger, even
// when a shadow ran right up to it, because armed-wins correction of a
// drifted shadow journal is the arming block's job; a shadow WINDOW START
// replays too, so the dry run covers positions opened long before it.
//
// Returns the two escrow-leaf facts the later steps need: whether this height
// shadows the leaf, and whether it is the arming block.
async function writeEscrowJournalForBlock(db, chain, network, blockIndex){
    const escArmed  = SUB.isEscrowLockedLeafActive(blockIndex, network, chain);
    const escShadow = SUB.isEscrowLockedLeafShadowActive(blockIndex, network, chain);
    // Hoisted out of the journal-write block below: the balances gate needs it
    // too. See the full-build gate for why.
    const armingBlock = escArmed && !SUB.isEscrowLockedLeafActive(blockIndex - 1, network, chain);
    if(escArmed || escShadow){
        const windowStart = escShadow && !SUB.isEscrowLockedLeafShadowActive(blockIndex - 1, network, chain);
        await EJW.writeEscrowJournal(db, blockIndex, { full: armingBlock || windowStart });
    }
    return { escShadow, armingBlock };
}

// balances_root: full init on the activation boundary, else incremental over
// the (address, tick) set the ledger touched this block. When the escrow
// leaf is SHADOWING, the incremental branch also collects this block's
// spendable-leaf updates so the shadow thread can replay the identical
// spendable set on its own root (null on the full-recompute branch, which
// makes the shadow full-build too).
async function balancesRootForBlock(db, smt, chain, network, blockIndex, isActivationBlock, armingBlock, escShadow){
    const prior = isActivationBlock ? [] : await db.doQueryStrict(
        'SELECT balances_root FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1',
        [chain, network, blockIndex - 1]);
    // The ARMING BLOCK full-builds too. The incremental branch applies
    // escrow leaves from touchedEscrowKeys(armingBlock), i.e. only journal rows
    // stamped at THIS height, while the arming replay deliberately writes no row for
    // a key whose total is unchanged (escrowJournalWriter.js `if(eq(prior,next))
    // continue`). After a §7 SHADOW window has already populated the journal, every
    // still-unchanged live lock therefore gets no arming-height row, and it is not in
    // the prior committed root either (block-1 committed the v1 leaf set), so it never
    // enters the newly committed balances_root. A snapshot/follower rebuilds the same
    // block from ESC.liveEscrowLeaves and includes it: two roots, one block, a false
    // halt. Routing the arming block through buildFullBalancesRoot converges the
    // source onto the follower's own enumeration, which is what the journal header
    // above already promises ("both twins then full-build from the journal").
    if(isActivationBlock || !prior.length || armingBlock){
        // No prior-block root to thread from: either the activation boundary, or a
        // snapshot-bootstrapped node (or a reorg that rolled the activation row
        // below this height) whose state_tree_roots history does not include
        // block-1. Do NOT substitute the empty-tree root: that silently emits a
        // balances_root forked from a from-genesis node. Instead full-recompute.
        // buildFullBalancesRoot derives the root from the entire current
        // net-balance set, independent of any prior root, so at this point in the
        // block (after the ledger writes, before commit) it yields the identical
        // root the incremental thread would have produced. Correct and
        // self-healing rather than a fork or a halt.
        //
        // The arming block takes this branch with a prior root PRESENT, so it skips
        // enforceTouchedSet / assertCommittedLeaves for that one block. Intended:
        // both guards verify incremental threading, which this branch does not do,
        // and the follower path this now mirrors does not run them either.
        if(!isActivationBlock && !armingBlock)
            getLogger().warn('stateCommitment: no prior state_tree_roots row for ' + chain + '/' + network +
                ' block ' + (blockIndex - 1) + '; full-recomputing balances_root for block ' + blockIndex +
                ' instead of threading from the empty root (snapshot-bootstrap or activation rolled below this height)');
        const balancesRoot = await buildFullBalancesRoot(db, chain, network, blockIndex);
        return { balancesRoot, shadowBalanceUpdates: null };
    }
    return threadBalancesRoot(db, smt, chain, network, blockIndex, prior[0].balances_root, escShadow);
}

// The incremental branch of balances_root: thread this block's touched spendable
// leaves and then its locked escrow leaves onto the prior block's root, and run
// both completeness guards (stateCommitment/touch_guards.js) on the result.
async function threadBalancesRoot(db, smt, chain, network, blockIndex, priorRoot, escShadow){
    let root = priorRoot;
    const touched = db._smtTouched ? Array.from(db._smtTouched) : [];
    const shadowBalanceUpdates = escShadow ? [] : null;
    for(const entry of touched){
        const [address, tick] = entry.split('\t');
        const balLeaf = leafOrNull(await getNetBalance(db, address, tick));
        const balKey  = M.balanceKey(chain, network, address, tick);
        root = await smt.update(root, balKey, balLeaf);
        if(shadowBalanceUpdates) shadowBalanceUpdates.push({ key: balKey, leaf: balLeaf });
    }
    // XCHAIN_ESC locked-balance leaves for this block (Stage B), height-gated.
    // Applied AFTER the spendable leaves and driven by its OWN touched set: an
    // order match writes the escrows release row against the recipient
    // GET_ADDRESS while the leaf that moves is the LOCKER's, so the balance
    // touched set is the wrong input and reusing it would update the wrong key
    // and miss the right one on every match. The journal answers per locker.
    if(SUB.isEscrowLockedLeafActive(blockIndex, network, chain)){
        root = await ESC.applyEscrowLeaves(db, smt, root, chain, network, blockIndex);
    }
    const balancesRoot = root;
    await enforceTouchedSet(db, blockIndex, touched);
    // Set membership cannot see a leaf that never landed, so the
    // block's own ledger keys are proved against the root that is about to
    // be committed. It runs AFTER the escrow leaves, on the exact value that
    // goes into the row, because a root nobody proved against is the thing
    // that made this fault class silent for three investigations.
    await assertCommittedLeaves(db, smt, chain, network, blockIndex, balancesRoot);
    return { balancesRoot, shadowBalanceUpdates };
}

// Assemble state_root from the finished sub-roots, derive the block Merkle root
// and the shadow columns, and write the block's state_tree_roots row. The
// assembly, the shadow value and the INSERT stay together in this file: the
// frozen twin suites read this path to prove every assembleStateRoot call takes
// only gated sub-roots and that the shadow value never reaches a committed column.
async function storeBlockRoots(db, smt, chain, network, blockIndex, subRootInputs){
    const { balancesRoot, stakesRoot, escShadow, shadowBalanceUpdates } = subRootInputs;
    const extraSubRoots   = SUB.gateSubRoots(await reservedSubRootCandidates(db, chain, network, blockIndex), blockIndex, network, chain);
    const stateRoot       = assembleStateRoot(balancesRoot, stakesRoot, extraSubRoots);
    const blockMerkleRoot = await computeBlockMerkleRoot(db, blockIndex);
    // Extension columns are read back OUT of the gated object, never off the
    // candidate: the column and the state_root it must reassemble to are then
    // written by one statement from one value, so no rewrite path (reorg,
    // self-heal, ON DUPLICATE KEY UPDATE) can leave the column stale against
    // its own root. NULL means EMPTY, which is why historical rows need no
    // backfill and why an inert chain keeps writing NULL forever.
    const contractStateRoot = extraSubRootColumn(extraSubRoots, 'contract_state_root');
    // Shadow-compute window (spec §7): derived at heights where the slot is NOT
    // committed, written to its OWN column, and never routed through gateSubRoots,
    // so there is no path by which it can reach state_root. Null on every chain
    // today, and an inert chain does not query contract_state at all.
    const contractStateShadow = extraSubRootColumn(
        await shadowSubRoots(db, chain, network, blockIndex), 'contract_state_root');
    // Stage B's shadow (spec §7, amended): the would-be balances_root with the
    // locked leaves applied, threading through its own column. Never routed
    // anywhere near assembleStateRoot, so no committed root can move; null on
    // every chain today (the shadow map is empty).
    const balancesEscrowShadow = !escShadow ? null :
        await ESC.resolveShadowBalancesRoot(db, smt, chain, network, blockIndex, shadowBalanceUpdates,
            () => buildFullBalancesRoot(db, chain, network, blockIndex, { forceEscrowLeaves: true }));

    await db.doQueryStrict(
        `INSERT INTO state_tree_roots
            (chain, network, block_index, balances_root, stakes_root, state_root, block_merkle_root, contract_state_root, contract_state_root_shadow, balances_root_escrow_shadow)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            balances_root=VALUES(balances_root), stakes_root=VALUES(stakes_root),
            state_root=VALUES(state_root), block_merkle_root=VALUES(block_merkle_root),
            contract_state_root=VALUES(contract_state_root),
            contract_state_root_shadow=VALUES(contract_state_root_shadow),
            balances_root_escrow_shadow=VALUES(balances_root_escrow_shadow)`,
        [chain, network, blockIndex, balancesRoot, stakesRoot, stateRoot, blockMerkleRoot, contractStateRoot, contractStateShadow, balancesEscrowShadow]);

    return { balances_root: balancesRoot, stakes_root: stakesRoot, state_root: stateRoot,
             block_merkle_root: blockMerkleRoot, contract_state_root: contractStateRoot };
}

module.exports = {
    EMPTY_ROOT_HEX,
    DbNodeStore,
    MemoryNodeStore,
    PersistentSMT,
    assembleStateRoot,
    extraSubRootColumn,
    reservedSubRootCandidates,
    shadowSubRoots,
    getNetBalance,
    gatherStakeEntries,
    buildStakesRoot,
    resetStakesMemo,
    computeBlockMerkleRoot,
    buildFullBalancesRoot,
    computeAndStoreRoots,
    reportOrphanStats,
    // Exported for test/unit/state_commitment_touch_guard.test.js. Both halves of
    // the guard are module-private on the block path, and this is the half whose
    // BEHAVIOUR (not source shape) has to be pinned by execution: the nine
    // touch-guard cases can only read the source, which is how a guard that
    // cannot detect its own fault class passed all nine.
    assertCommittedLeaves
};

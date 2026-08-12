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

const M = require('./merkle.js');
const SUB = require('./state_subtree_activation.js');
const CST = require('./contractStateSubtree.js');
const ESC = require('./escrowLeafSubtree.js');
const EJW = require('./escrowJournalWriter.js');   // SOURCE ONLY: the follower replicates these rows

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
// : putMany exists because ONE key update writes SMT_DEPTH internal nodes
// and a value leaf's ancestors are never an empty subtree, so the write loop is
// always a full 256 rows. Issued one statement at a time that is 256 sequential
// round trips per key, which on the BTC regtest venue (49 stake keys rebuilt from
// an empty root every block) is 12,544 round trips and 25-66s of wall clock per
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
class PersistentSMT {
    constructor(store){ this.store = store; }

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
            const row = await this.store.get(cur);
            if(!row){ empty = true; siblings[d] = sibEmptyHex; continue; }
            const bit = M.bitAt(keyBuf, d);
            siblings[d] = (bit === 0) ? row.right_hash : row.left_hash;
            cur         = (bit === 0) ? row.left_hash  : row.right_hash;
        }
        return { siblings, oldLeaf: empty ? EMPTY0_HEX : cur };
    }

    // Persist a path's nodes, preferring the store's batch write. The fallback
    // is the pre- behaviour and exists only for stores that predate
    // putMany (bare {get, put} fakes and the bin/ instrumentation decorator);
    // it writes the same rows in the same order at one round trip each.
    async _putBatch(nodes){
        if(typeof this.store.putMany === 'function'){
            await this.store.putMany(nodes);
            return;
        }
        for(const n of nodes) await this.store.put(n.hash, n.left, n.right);
    }

    // Set (leafHex) or delete (null) a key, persisting new internal nodes. Returns
    // the new root hex. Apply keys sequentially: each call threads the updated root
    // so shared-prefix keys see prior inserts.
    async update(rootHex, keyBuf, newLeafHexOrNull){
        const { siblings } = await this._descend(rootHex, keyBuf);
        let cur = (newLeafHexOrNull == null) ? EMPTY0_HEX : newLeafHexOrNull;
        // Collect the path's nodes and write them in ONE batch after the climb
        // rather than a round trip per level . Deferring is safe because
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
// { totalNodes, reachableNodes, orphanCount, reachabilitySkipped }.
async function reportOrphanStats(query, chain, network, opts){
    opts = opts || {};
    const maxNodes = opts.maxNodes || parseInt(process.env.STATE_TREE_METRIC_MAX_NODES, 10) || 2000000;
    const cnt = await query('SELECT COUNT(*) AS c FROM state_tree_nodes', []);
    const totalNodes = cnt.length ? Number(cnt[0].c) : 0;
    if(totalNodes === 0) return { totalNodes: 0, reachableNodes: 0, orphanCount: 0, reachabilitySkipped: false };
    // Above the in-memory mark ceiling, do not go silent. Load a bounded, deterministic
    // sample (ORDER BY node_hash LIMIT maxNodes) and mark reachability WITHIN that sample
    // from the same retained root set, so a rough orphan ratio and growth stay observable
    // without an unbounded in-memory mark. Reported as an estimate (reachabilityEstimated)
    // scoped to sampledNodes; this whole function is observability only and never feeds a
    // consensus hash, so a sampled figure is safe here.
    if(totalNodes > maxNodes){
        const sampleRows = await query('SELECT node_hash, left_hash, right_hash FROM state_tree_nodes ORDER BY node_hash LIMIT ?', [maxNodes]);
        const sampleNodes = new Map();
        for(const r of sampleRows) sampleNodes.set(r.node_hash, { l: r.left_hash, r: r.right_hash });
        const sampleRootRows = await query(
            'SELECT DISTINCT balances_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
            'UNION SELECT DISTINCT stakes_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
            'UNION SELECT DISTINCT contract_state_root AS r FROM state_tree_roots WHERE chain=? AND network=? AND contract_state_root IS NOT NULL',
            [chain, network, chain, network, chain, network]);
        const sampleVisited = new Set();
        const sampleStack = [];
        for(const rr of sampleRootRows){
            const root = rr.r;
            if(root && !EMPTY_CONSTANTS.has(root) && sampleNodes.has(root)) sampleStack.push(root);
        }
        while(sampleStack.length){
            const h = sampleStack.pop();
            if(sampleVisited.has(h)) continue;
            sampleVisited.add(h);
            const row = sampleNodes.get(h);
            if(!row) continue;
            for(const child of [row.l, row.r]){
                if(child && !EMPTY_CONSTANTS.has(child) && !sampleVisited.has(child) && sampleNodes.has(child)) sampleStack.push(child);
            }
        }
        const sampledNodes = sampleNodes.size;
        const sampledReachable = sampleVisited.size;
        return { totalNodes, reachableNodes: sampledReachable, orphanCount: sampledNodes - sampledReachable, reachabilitySkipped: false, reachabilityEstimated: true, sampledNodes };
    }

    const rows = await query('SELECT node_hash, left_hash, right_hash FROM state_tree_nodes', []);
    const nodes = new Map();
    for(const r of rows) nodes.set(r.node_hash, { l: r.left_hash, r: r.right_hash });

    const rootRows = await query(
        'SELECT DISTINCT balances_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
        'UNION SELECT DISTINCT stakes_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
        'UNION SELECT DISTINCT contract_state_root AS r FROM state_tree_roots WHERE chain=? AND network=? AND contract_state_root IS NOT NULL',
        [chain, network, chain, network, chain, network]);

    // Iterative DFS from every retained root; only push hashes that actually have a
    // row (EMPTY constants and absent children are skipped). visited == reachable set.
    const visited = new Set();
    const stack = [];
    for(const rr of rootRows){
        const root = rr.r;
        if(root && !EMPTY_CONSTANTS.has(root) && nodes.has(root)) stack.push(root);
    }
    while(stack.length){
        const h = stack.pop();
        if(visited.has(h)) continue;
        visited.add(h);
        const row = nodes.get(h);
        if(!row) continue;
        for(const child of [row.l, row.r]){
            if(child && !EMPTY_CONSTANTS.has(child) && !visited.has(child) && nodes.has(child)) stack.push(child);
        }
    }
    const reachableNodes = visited.size;
    return { totalNodes: nodes.size, reachableNodes, orphanCount: nodes.size - reachableNodes, reachabilitySkipped: false };
}

// Assemble the top-level state_root from the two v1 sub-roots plus any RESERVED
// slot that its flag-day has armed (SPV spec §4.1; design in
// claude/specs/spv-state-subtree-extension.md).
//
// `extraSubRoots` is the forward-compatible carrier for ownership_root /
// tokens_root / contract_state_root and MUST be the output of
// state_subtree_activation.gateSubRoots(), never a caller's raw candidates: the
// gate is what keeps an un-armed slot EMPTY. It is null today (every slot inert),
// and merkle.stateRoot() maps a null/absent/empty-root slot to the identical
// EMPTY_SMT_ROOT leaf, so this is byte-identical to the old two-argument
// assembly on every chain. The equality is asserted, not assumed, in
// test/unit/stateSubtreeActivation.test.js.
function assembleStateRoot(balancesRootHex, stakesRootHex, extraSubRoots){
    const subRoots = { balances_root: balancesRootHex, stakes_root: stakesRootHex };
    if(extraSubRoots){
        for(const name of SUB.RESERVED_SUBTREES)
            if(extraSubRoots[name]) subRoots[name] = extraSubRoots[name];
    }
    return M.toHex(M.stateRoot(subRoots));
}

// Persisted column value for one reserved slot, taken from the GATED sub-root
// object. Returns null (SQL NULL = EMPTY) when the slot is inert at this height
// or the gate dropped it, so a row's extension column always describes the same
// leaf set as the row's own state_root.
function extraSubRootColumn(extraSubRoots, slotName){
    return (extraSubRoots && extraSubRoots[slotName]) ? extraSubRoots[slotName] : null;
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

// ---- Leaf value derivation (authoritative, never the balances cache) --------
// Per SPV spec §4.2 the leaf is the authoritative SUM(credits)-SUM(debits) at 18 dp,
// NOT the mutable balances cache (the per-block sanityCheck verifies aggregate
// SUPPLIES, not per-address balances, so the cache is not guaranteed correct
// per-key). Cost is O(history per touched key); flagged for Phase-1 throughput
// measurement on the fast chains. Resolves through the index tables by canonical
// string (never surrogate ids), matching BLOCK_HASH_VERSION's id-independence rule.
const ZERO_CANON = M.canonicalAmount('0');

function _nz(amountStr){ return M.canonicalAmount(String(amountStr)); }

// Returns the value-leaf hex for an amount, or null when it is exactly zero
// (delete-on-zero, normative §4.2).
function _leafOrNull(amountStr){
    const canon = _nz(amountStr);
    return (canon === ZERO_CANON) ? null : M.toHex(M.leafHash(canon));
}

async function getNetBalance(db, address, tick){
    const rows = await db.doQueryStrict(
        `SELECT
            (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                INNER JOIN index_addresses a ON a.id=c.address_id
                INNER JOIN index_tickers   t ON t.id=c.tick_id
                WHERE a.address=? AND t.tick=?) AS cr,
            (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                INNER JOIN index_addresses a ON a.id=d.address_id
                INNER JOIN index_tickers   t ON t.id=d.tick_id
                WHERE a.address=? AND t.tick=?) AS dr`,
        [address, tick, address, tick]);
    const cr = rows.length ? String(rows[0].cr) : '0';
    const dr = rows.length ? String(rows[0].dr) : '0';
    // Render via bcstr: bcsub returns a decimal.js bignumber whose String() form
    // goes exponential below 1e-7 ("1e-8"), which canonicalAmount rejects and
    // wedges the block loop. bcstr is minimal fixed notation, byte-identical to
    // the sync follower's SQL minimal-decimal rendering of the same net.
    return db.util.bcstr(db.util.bcsub(cr, dr, 18));
}

// Locked-escrow leaf (XCHAIN_ESC): BUILT and gated, no longer deferred (SPV
// sub-tree spec §3 Stage B, ). The 2026-06-18 finding that killed the
// naive derivation still stands and is why the journal exists: the escrows
// table keys a lock (+amount) to the order SOURCE but keys nine release sites
// to the recipient, so SUM(escrows) per (address, tick) does NOT net per key
// and only the per-tick GLOBAL sum nets to zero. The journal writer
// (escrowJournalWriter.js) re-keys those rows to their locker at write time;
// escrowLeafSubtree.js derives the leaves from the journal, applied inside
// balances_root when ESCROW_LOCKED_LEAF_ACTIVATION arms a height (and into
// the shadow column while ESCROW_LOCKED_LEAF_SHADOW does). Until then
// balances_root commits ONLY the net-spendable leaf, byte-identical to v1.

// ---- Stakes sub-tree (BTC-only, §4.1) ---------------------------------------
// Built fresh each BTC block from the authoritative capability stake-weight query
// (the set is small, bounded by VALIDATOR_QUERY_LIMIT). One leaf per (pubkey,
// capability) with the source-deduped weight; absent stakers are simply not in the
// set (delete-on-zero falls out). Keyed by canonical pubkey+capability strings.
async function gatherStakeEntries(db, blockIndex){
    const caps = (db.config['STAKING'] && db.config['STAKING']['CAPABILITIES'])
        ? Object.keys(db.config['STAKING']['CAPABILITIES']) : [];
    const entries = [];
    for(const capability of caps){
        const rows = await db.getStakeWeightsByCapability(capability, blockIndex);
        const seenSource = new Map();   // source -> weight (first wins; equal per source)
        for(const r of (rows || [])){
            if(!r || r.pubkey == null) continue;
            if(_nz(String(r.weight == null ? '0' : r.weight)) === ZERO_CANON) continue;   // zero cannot qualify
            const source = String(r.source);
            // Member leaf commits SOURCE + weight so a light client can source-dedupe
            // signer stake exactly as swq.meetsStakeThreshold does (validator-set proof).
            entries.push([ M.toHex(M.stakeKey(String(r.pubkey), capability)),
                           M.toHex(M.stakeMemberLeaf(source, String(r.weight))) ]);
            if(!seenSource.has(source)) seenSource.set(source, String(r.weight));
        }
        // Total leaf: the source-deduped quorum denominator S, so a client can check
        // 3·Σ(signer-source weight) > 2·S without enumerating the full set (spec §7).
        const total = M.sumCanonicalAmounts(Array.from(seenSource.values()));
        if(_nz(total) !== ZERO_CANON)
            entries.push([ M.toHex(M.stakeKey(M.STAKE_TOTAL_PUBKEY, capability)),
                           M.toHex(M.stakeTotalLeaf(total)) ]);
    }
    return entries;
}

// Rebuild the stakes tree only when the stake set actually changed .
//
// buildFull writes SMT_DEPTH nodes per key, so this tree costs keys x 256 node
// writes on EVERY BTC block - 12,544 on the regtest venue's 49 keys - and the
// stake set changes on almost none of them. Every one of those writes is an
// INSERT IGNORE no-op, but each still probes a primary key far larger than the
// buffer pool, which is what put BTC regtest block parse at 25-66s against LTC's
// 3-5s for the same code (LTC commits the empty stakes root and never pays it).
//
// The memo is sound because buildFull is a PURE function of its entries: the node
// store is content-addressed, so the same entry set always yields the same root.
// stateCommitment.test.js pins both halves of that - equality with the merkle.js
// reference, and insert-order independence.
//
// Every way this can be wrong is a way it rebuilds. It shortcuts ONLY when the
// entries are identical to those of the block IMMEDIATELY BEFORE it, which this
// same process built and committed, and whose nodes are therefore already durable
// (state_tree_nodes is COW and rollback-exempt). Keyed on block CONTINUITY and not
// on the digest alone, so a reorg, a rollback, or a cold start lands on a block
// that is not the memo's successor and rebuilds. That direction matters: a cache
// in a consensus path may only ever fail toward the slow correct answer, and the
// one that failed the other way here  did so because it was keyed on a
// MUTABLE dense id rather than on its own inputs.
let _stakesMemo = null;

function _stakeEntriesDigest(entries){
    // Sorted, because buildFull is order-independent: an entry set that merely
    // reordered must still hit. Length-prefixed and separator-joined so no pair
    // boundary can be forged by a value that happens to contain the separator.
    const pairs = entries.map(e => String(e[0]) + ':' + String(e[1])).sort();
    return M.toHex(M.sha256(Buffer.from(pairs.length + '|' + pairs.join('|'), 'utf8')));
}

// Exported for tests and for any caller that wipes the node store underneath a
// live process; forgetting the memo only ever costs one rebuild.
function resetStakesMemo(){ _stakesMemo = null; }

async function buildStakesRoot(smt, chain, network, blockIndex, entries){
    const digest = _stakeEntriesDigest(entries);
    const memo   = _stakesMemo;
    if(memo && memo.chain === chain && memo.network === network
            && memo.blockIndex === blockIndex - 1 && memo.digest === digest){
        // One indexed read weighed against 12,544 writes: proves the memoized tree
        // is still IN the store before trusting it. It does not prove every interior
        // node survived - only a prune could remove one, and reachability marking
        // keeps whatever a retained root reaches - so this is a cheap floor, stated
        // as such rather than sold as verification.
        if(memo.root === EMPTY_ROOT_HEX || await smt.store.get(memo.root)){
            _stakesMemo = { chain, network, blockIndex, digest, root: memo.root };
            return memo.root;
        }
    }
    const root = await smt.buildFull(entries);
    _stakesMemo = { chain, network, blockIndex, digest, root };
    return root;
}

// ---- Block-content Merkle root (§5) -----------------------------------------
// Leaves over the EXACT canonical rows + order the flat hashes cover (db
// getBlockLeafRows reuses the getBlockHashes stash), in the frozen cross-kind
// total order. The ordering itself lives in merkle.blockMerkleLeaves (the
// twin-guarded module) so the explorer proof server locates a row's leaf index
// with byte-identical logic; this just hashes the assembled vector.
async function computeBlockMerkleRoot(db, blockIndex){
    const rows = await db.getBlockLeafRows(blockIndex);
    return M.toHex(M.blockMerkleRoot(M.blockMerkleLeaves(rows)));
}

// ---- Full balances-tree initialization (flag-day cutover, §4.3) -------------
// One-time at the activation boundary block: seed the balances SMT from ALL
// pre-existing nonzero net balances (escrow leaf deferred from v1, see note
// above). (At genesis activation this is just the boundary block's own
// effects.) Persists nodes.
async function buildFullBalancesRoot(db, chain, network, blockIndex, opts){
    const smt = new PersistentSMT(new DbNodeStore(db));
    let root = EMPTY_ROOT_HEX;
    const bals = await db.doQueryStrict(
        `SELECT a.address AS address, t.tick AS tick, CAST(SUM(s.amt) AS CHAR) AS net FROM (
            SELECT address_id, tick_id,  CAST(amount AS DECIMAL(60,18)) AS amt FROM credits
            UNION ALL
            SELECT address_id, tick_id, -CAST(amount AS DECIMAL(60,18)) AS amt FROM debits
         ) s
         INNER JOIN index_addresses a ON a.id=s.address_id
         INNER JOIN index_tickers   t ON t.id=s.tick_id
         GROUP BY s.address_id, s.tick_id
         HAVING SUM(s.amt) <> 0`, []);
    for(const r of bals){
        if(r.address == null || r.tick == null) continue;
        const leaf = _leafOrNull(r.net);
        if(leaf == null) continue;
        root = await smt.update(root, M.balanceKey(chain, network, r.address, r.tick), leaf);
    }
    // XCHAIN_ESC locked-balance leaves (Stage B), height-gated. Work item 2: this
    // function had NO height and three callers (activation-boundary init, the
    // indexer self-heal full recompute, seedSnapshotRoots), so after the escrow
    // leaf arms it could not decide whether locked leaves belong in the tree, and
    // the self-heal path would have silently rebuilt a locked-leaf-FREE
    // balances_root on the SOURCE. That is a quiet fork, the worst kind, so the
    // height is now a parameter and a caller that omits it gets the v1 leaf set.
    // opts.forceEscrowLeaves is the §7 shadow window's build of the SAME set at
    // heights where the leaf is not yet committed; only the shadow path passes it.
    if(SUB.isEscrowLockedLeafActive(blockIndex, network, chain) || (opts && opts.forceEscrowLeaves)){
        for(const e of await ESC.liveEscrowLeaves(db))
            root = await smt.update(root, M.escrowKey(chain, network, e.address, e.tick), e.leaf);
    }
    return root;
}

// ---- Touched-set guard  ---------------------------------------------
//
// ON BY DEFAULT, and it refuses to commit the block rather than committing a
// balances_root known to be incomplete.
//
// WHY THIS IS A GUARD AND NOT A DIAGNOSTIC. Balance leaves have gone missing on
// every regtest venue (BTC 15 of 1531 ledger-changing blocks, LTC 8 of 880,
// DOGE 2 of 648). Two real defects were found and fixed, and BOTH were mis-
// diagnosed at least once first. Block 10296 then skipped under conditions that
// exclude both of them, so at least one mechanism is still unknown. The
// unifying property is not the cause, it is the SILENCE: a touched key recorded
// under a key the ledger does not name makes getNetBalance return 0,
// _leafOrNull maps 0 to null, and the commitment deletes a key that never
// existed. The update is a no-op, the root does not move, nothing errors, and
// every peer running the same code agrees. It only surfaces when some node
// full-rebuilds (a follower's seedSnapshotRoots, a flag-day arming block) and
// diverges from the chain it is following.
//
// So this stops trying to enumerate causes and closes the class: whatever the
// mechanism, a block whose ledger moved keys that the touched set did not apply
// is refused. That protects against the mechanisms not yet found, which is the
// whole point of doing it this way.
//
// ---- Why the check is a SUBSET and not an equality -------------------------
//
// missing (expected minus applied) is the fault and is enforcing. extra (applied
// minus expected) has legitimate causes and must NEVER halt a chain:
//
//   - escrows. createLedgerChangeRecord records a touch for credits, debits AND
//     escrows, while the expected set below reads credits and debits only, so an
//     escrow-only key is legitimately applied and not expected.
//   - backdated cooldown-refund credits, which reuse an EARLIER block's
//     action_index. The choke point captures them in the block that WRITES them
//     while a block-range query attributes them to the block that OWNS the
//     action. That asymmetry is deliberate and documented at the choke point.
//
// Both only ADD to applied, so expected is a subset of applied whenever the
// commitment is healthy, and the subset direction stays exact. extra is
// therefore reported only under INDEXER_SMT_TOUCH_AUDIT=1, where it is the
// direction that would NAME an unknown mechanism.
//
// ---- Failure posture -------------------------------------------------------
//
// Fail closed, matching what this codebase does everywhere else: the follower
// halts on divergence, doQueryStrict throws rather than returning [], the
// arming block refuses rather than guessing. Throwing here rolls the block back
// and it is retried, so a transient cause clears itself and a real one stops
// the node instead of forking it.
//
// INDEXER_TOUCH_GUARD=warn downgrades to a log. That is an operational safety
// valve, not a tuning knob: a node running with it committed a balances_root it
// knows is incomplete, and will diverge from any node that full-rebuilds.
async function _enforceTouchedSet(db, blockIndex, touched){
    const expected = await _ledgerKeysForBlock(db, blockIndex);
    if(!expected.size) return;

    const applied = new Set(touched);
    const missing = [...expected].filter(k => !applied.has(k));

    if(process.env.INDEXER_SMT_TOUCH_AUDIT === '1'){
        const extra = [...applied].filter(k => !expected.has(k));
        if(extra.length)
            console.log('SMT-TOUCH-AUDIT block=' + blockIndex +
                ' extra=' + JSON.stringify(extra.map(k => k.split('\t'))));
    }

    if(!missing.length) return;

    const detail = JSON.stringify(missing.map(k => k.split('\t')));
    const msg = 'balances touched-set guard FAILED at block ' + blockIndex +
        ': the ledger moved ' + missing.length + ' key(s) the commitment did not apply, so ' +
        'balances_root would be committed incomplete. keys=' + detail + ' ';
    if(process.env.INDEXER_TOUCH_GUARD === 'warn'){
        console.error(msg + ' [INDEXER_TOUCH_GUARD=warn: COMMITTING ANYWAY, this node will ' +
            'diverge from any node that full-rebuilds]');
        return;
    }
    throw new Error(msg);
}

// The (address, tick) keys THIS block's ledger moved, as canonical strings
// resolved through the index tables, which is the same derivation the
// commitment's own key uses. Shared by the touched-set guard above and the
// leaf-presence assertion below so the two can never drift into disagreeing
// about what the block moved.
//
// doQueryStrict, never doQuery: inside the block transaction a failed read
// throws and the block retries. A guard that reads through the fail-soft path
// would see [] as "the ledger moved nothing" and pass every block, which is
// worse than not having a guard at all (M-17).
async function _ledgerKeysForBlock(db, blockIndex){
    const rows = await db.doQueryStrict(
        `SELECT DISTINCT ia.address AS address, it.tick AS tick
           FROM (
                SELECT action_index, address_id, tick_id FROM credits
                UNION ALL
                SELECT action_index, address_id, tick_id FROM debits
           ) s
           INNER JOIN actions a          ON a.action_index = s.action_index
           INNER JOIN index_addresses ia ON ia.id = s.address_id
           INNER JOIN index_tickers   it ON it.id = s.tick_id
          WHERE a.block_index = ?`, [blockIndex]);

    const keys = new Set();
    for(const r of (rows || []))
        if(r.address != null && r.tick != null && r.tick !== '')
            keys.add(r.address + '\t' + r.tick);
    return keys;
}

// ---- Post-commit leaf-presence assertion  ---------------------------
//
// The touched-set guard above compares SET MEMBERSHIP in both directions, and
// the  fault class is not a membership failure. The key IS touched and IS
// in `applied`; getNetBalance then answers 0 for it, _leafOrNull maps 0 to null,
// and the commitment DELETES a key that never existed. `missing` is empty,
// nothing throws, nothing logs, and the leaf never lands. That was PROVEN on the
//  replay venue: with the guard live and the audit armed, block 103
// neither threw nor logged, while the per-key probe reported that same block's
// key absent from the committed tree. The guard asks "was the key touched" and
// the probe asks "did the leaf land"; only the second question is the one that
// decides whether balances_root is complete, so this asks it too.
//
// It asks in vivo, at the one moment the answer is still recoverable: after the
// block's balances_root is final and before it is written, prove every key the
// block's ledger moved against that root.
//
// A key whose leaf is ABSENT is a fault only when its net is non-zero. A
// net-zero key is applied as a DELETE and correctly leaves no leaf (§4.2
// delete-on-zero), which is exactly why a healthy block can leave the root
// untouched, so treating absence alone as a fault would halt healthy chains.
// Judging by anything other than the net AS OF THIS HEIGHT invents faults too:
// the  per-key sweep produced four spurious hits from today's balance and
// zero from the block's own. Inside the block transaction getNetBalance IS the
// as-of-height net, which is what makes an in-block assertion both cheap and
// exact where an after-the-fact one is neither.
//
// Cost: one descent per moved key, and the net re-read is deferred until a leaf
// is actually found absent, so a healthy block pays no extra history scan. The
// measured shape on BTC regtest is 1972 moved keys over 1516 healthy
// ledger-changing blocks (~1.3 per block) with zero false positives.
//
// Value equality (leaf == leafHash(net)) is deliberately NOT asserted: it would
// cost an O(history) net scan per moved key on every block to re-check a value
// this same block wrote from that same query, while the fault class being closed
// is absence.
async function _assertCommittedLeaves(db, smt, chain, network, blockIndex, balancesRootHex){
    const expected = await _ledgerKeysForBlock(db, blockIndex);
    if(!expected.size) return;

    const absent = [];
    for(const entry of expected){
        const [address, tick] = entry.split('\t');
        const proof = await smt.prove(balancesRootHex, M.balanceKey(chain, network, address, tick));
        if(proof.leaf_value != null) continue;               // the leaf landed
        const net = await getNetBalance(db, address, tick);
        if(_leafOrNull(net) == null) continue;               // net-zero: no leaf by design
        absent.push([address, tick, _nz(net)]);
    }
    if(!absent.length) return;

    const msg = 'balances leaf-presence assertion FAILED at block ' + blockIndex + ': ' +
        absent.length + ' key(s) the ledger moved have NO leaf in the committed balances_root ' +
        'while their net is non-zero, so balances_root would be committed incomplete. ' +
        'keys=' + JSON.stringify(absent) + ' ';
    if(process.env.INDEXER_TOUCH_GUARD === 'warn'){
        console.error(msg + ' [INDEXER_TOUCH_GUARD=warn: COMMITTING ANYWAY, this node will ' +
            'diverge from any node that full-rebuilds]');
        return;
    }
    throw new Error(msg);
}

// ---- Orchestrator -----------------------------------------------------------
// Compute + persist the per-block roots, INSIDE the block transaction (the caller
// runs this after sanityCheck, before commit). chain = COIN, network = NETWORK.
async function computeAndStoreRoots(db, chain, network, blockIndex, isActivationBlock){
    const smt = new PersistentSMT(new DbNodeStore(db));

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
    const escArmed  = SUB.isEscrowLockedLeafActive(blockIndex, network, chain);
    const escShadow = SUB.isEscrowLockedLeafShadowActive(blockIndex, network, chain);
    // Hoisted out of the journal-write block below: the balances gate needs it too
    // (). See the full-build gate for why.
    const armingBlock = escArmed && !SUB.isEscrowLockedLeafActive(blockIndex - 1, network, chain);
    if(escArmed || escShadow){
        const windowStart = escShadow && !SUB.isEscrowLockedLeafShadowActive(blockIndex - 1, network, chain);
        await EJW.writeEscrowJournal(db, blockIndex, { full: armingBlock || windowStart });
    }

    // balances_root: full init on the activation boundary, else incremental over
    // the (address, tick) set the ledger touched this block. When the escrow
    // leaf is SHADOWING, the incremental branch also collects this block's
    // spendable-leaf updates so the shadow thread can replay the identical
    // spendable set on its own root (null on the full-recompute branch, which
    // makes the shadow full-build too).
    let balancesRoot;
    let shadowBalanceUpdates = null;
    const prior = isActivationBlock ? [] : await db.doQueryStrict(
        'SELECT balances_root FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1',
        [chain, network, blockIndex - 1]);
    // The ARMING BLOCK full-builds too (). The incremental branch applies
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
        // _enforceTouchedSet / _assertCommittedLeaves for that one block. Intended:
        // both guards verify incremental threading, which this branch does not do,
        // and the follower path this now mirrors does not run them either.
        if(!isActivationBlock && !armingBlock)
            console.warn('stateCommitment: no prior state_tree_roots row for ' + chain + '/' + network +
                ' block ' + (blockIndex - 1) + '; full-recomputing balances_root for block ' + blockIndex +
                ' instead of threading from the empty root (snapshot-bootstrap or activation rolled below this height)');
        balancesRoot = await buildFullBalancesRoot(db, chain, network, blockIndex);
    } else {
        let root = prior[0].balances_root;
        const touched = db._smtTouched ? Array.from(db._smtTouched) : [];
        if(escShadow) shadowBalanceUpdates = [];
        for(const entry of touched){
            const [address, tick] = entry.split('\t');
            const balLeaf = _leafOrNull(await getNetBalance(db, address, tick));
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
        balancesRoot = root;
        await _enforceTouchedSet(db, blockIndex, touched);
        // Set membership cannot see a leaf that never landed , so the
        // block's own ledger keys are proved against the root that is about to
        // be committed. It runs AFTER the escrow leaves, on the exact value that
        // goes into the row, because a root nobody proved against is the thing
        // that made this fault class silent for three investigations.
        await _assertCommittedLeaves(db, smt, chain, network, blockIndex, balancesRoot);
    }

    // stakes_root: BTC-only; LTC/DOGE commit the empty-SMT root.
    let stakesRoot = EMPTY_ROOT_HEX;
    if(chain === 'BTC'){
        const stakeEntries = await gatherStakeEntries(db, blockIndex);
        stakesRoot = await buildStakesRoot(smt, chain, network, blockIndex, stakeEntries);
    }

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
    // Exported for test/unit/stateCommitment.touch-guard.test.js. Both halves of
    // the guard are module-private on the block path, and this is the half whose
    // BEHAVIOUR (not source shape) has to be pinned by execution: the nine
    // touch-guard cases can only read the source, which is how a guard that
    // cannot detect its own fault class passed all nine.
    _assertCommittedLeaves
};

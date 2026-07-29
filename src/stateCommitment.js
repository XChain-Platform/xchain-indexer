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
}

// In-memory store: used by the unit fuzz test and any caller that wants a
// throwaway tree. Same interface as DbNodeStore.
class MemoryNodeStore {
    constructor(){ this.map = new Map(); }
    async get(nodeHashHex){ return this.map.has(nodeHashHex) ? this.map.get(nodeHashHex) : null; }
    async put(nodeHashHex, leftHex, rightHex){
        if(!this.map.has(nodeHashHex)) this.map.set(nodeHashHex, { left_hash: leftHex, right_hash: rightHex });
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

    // Set (leafHex) or delete (null) a key, persisting new internal nodes. Returns
    // the new root hex. Apply keys sequentially: each call threads the updated root
    // so shared-prefix keys see prior inserts.
    async update(rootHex, keyBuf, newLeafHexOrNull){
        const { siblings } = await this._descend(rootHex, keyBuf);
        let cur = (newLeafHexOrNull == null) ? EMPTY0_HEX : newLeafHexOrNull;
        for(let d = M.SMT_DEPTH - 1; d >= 0; d--){
            const bit  = M.bitAt(keyBuf, d);
            const sib  = siblings[d];
            const left  = (bit === 0) ? cur : sib;
            const right = (bit === 0) ? sib : cur;
            const parent = M.toHex(M.nodeHash(left, right));
            // Skip storing an all-empty subtree: its hash is an EMPTY constant with no row.
            if(parent !== M.toHex(M.EMPTY[M.SMT_DEPTH - d]))
                await this.store.put(parent, left, right);
            cur = parent;
        }
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
    if(escArmed || escShadow){
        const armingBlock = escArmed && !SUB.isEscrowLockedLeafActive(blockIndex - 1, network, chain);
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
    if(isActivationBlock || !prior.length){
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
        if(!isActivationBlock)
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
    }

    // stakes_root: BTC-only; LTC/DOGE commit the empty-SMT root.
    let stakesRoot = EMPTY_ROOT_HEX;
    if(chain === 'BTC'){
        const stakeEntries = await gatherStakeEntries(db, blockIndex);
        stakesRoot = await smt.buildFull(stakeEntries);
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
    computeBlockMerkleRoot,
    buildFullBalancesRoot,
    computeAndStoreRoots,
    reportOrphanStats
};

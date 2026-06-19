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

const EMPTY_ROOT_HEX = M.toHex(M.EMPTY_SMT_ROOT);   // root of an empty depth-256 SMT
const EMPTY0_HEX     = M.toHex(M.EMPTY[0]);

// ---- Node stores ------------------------------------------------------------
// Interface: async get(nodeHashHex) -> { left_hash, right_hash } | null ;
//            async put(nodeHashHex, leftHex, rightHex) -> void  (idempotent / INSERT IGNORE)

// MariaDB-backed content-addressed store over `state_tree_nodes`.
class DbNodeStore {
    constructor(db){ this.db = db; }
    async get(nodeHashHex){
        const rows = await this.db.doQuery(
            'SELECT left_hash, right_hash FROM state_tree_nodes WHERE node_hash=? LIMIT 1', [nodeHashHex]);
        return rows.length ? rows[0] : null;
    }
    async put(nodeHashHex, leftHex, rightHex){
        await this.db.doQuery(
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

// Assemble the top-level state_root from the two v1 sub-roots (others EMPTY).
function assembleStateRoot(balancesRootHex, stakesRootHex){
    return M.toHex(M.stateRoot({ balances_root: balancesRootHex, stakes_root: stakesRootHex }));
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
    const rows = await db.doQuery(
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
    return db.util.bcsub(cr, dr, 18);
}

// Locked-escrow leaf is DEFERRED out of v1 (SPV spec §4.2 D2, revised). The
// escrows table keys a lock (+amount) to the order SOURCE but keys the match
// release (-amount) to the recipient GET_ADDRESS (order.js:466 vs
// order_match.js:331/349), so SUM(escrows) per (address, tick) does NOT net to
// zero on a match: the locker key is left stale-positive and the recipient key
// goes negative. Only the per-tick GLOBAL sum nets to zero (which is all the
// aggregate supply sanityCheck verifies). A per-address locked leaf therefore
// cannot be derived from SUM(escrows): it both crashes the non-negative amount
// encoder on the negative key and mis-reports a stale lock on the locker key.
// balances_root commits ONLY the net-spendable balance leaf in v1 (already net
// of escrow, so it stays correct); a true per-address locked-balance commitment
// is deferred to Phase 2 with an open-order-derived source.

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
async function buildFullBalancesRoot(db, chain, network){
    const smt = new PersistentSMT(new DbNodeStore(db));
    let root = EMPTY_ROOT_HEX;
    const bals = await db.doQuery(
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
    // Escrow (locked) leaf intentionally omitted from v1 (see deferral note above).
    return root;
}

// ---- Orchestrator -----------------------------------------------------------
// Compute + persist the per-block roots, INSIDE the block transaction (the caller
// runs this after sanityCheck, before commit). chain = COIN, network = NETWORK.
async function computeAndStoreRoots(db, chain, network, blockIndex, isActivationBlock){
    const smt = new PersistentSMT(new DbNodeStore(db));

    // balances_root: full init on the activation boundary, else incremental over
    // the (address, tick) set the ledger touched this block.
    let balancesRoot;
    const prior = isActivationBlock ? [] : await db.doQuery(
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
        balancesRoot = await buildFullBalancesRoot(db, chain, network);
    } else {
        let root = prior[0].balances_root;
        const touched = db._smtTouched ? Array.from(db._smtTouched) : [];
        for(const entry of touched){
            const [address, tick] = entry.split('\t');
            const balLeaf = _leafOrNull(await getNetBalance(db, address, tick));
            root = await smt.update(root, M.balanceKey(chain, network, address, tick), balLeaf);
            // Escrow (locked) leaf intentionally omitted from v1 (see deferral note above).
        }
        balancesRoot = root;
    }

    // stakes_root: BTC-only; LTC/DOGE commit the empty-SMT root.
    let stakesRoot = EMPTY_ROOT_HEX;
    if(chain === 'BTC'){
        const stakeEntries = await gatherStakeEntries(db, blockIndex);
        stakesRoot = await smt.buildFull(stakeEntries);
    }

    const stateRoot       = assembleStateRoot(balancesRoot, stakesRoot);
    const blockMerkleRoot = await computeBlockMerkleRoot(db, blockIndex);

    await db.doQuery(
        `INSERT INTO state_tree_roots
            (chain, network, block_index, balances_root, stakes_root, state_root, block_merkle_root)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            balances_root=VALUES(balances_root), stakes_root=VALUES(stakes_root),
            state_root=VALUES(state_root), block_merkle_root=VALUES(block_merkle_root)`,
        [chain, network, blockIndex, balancesRoot, stakesRoot, stateRoot, blockMerkleRoot]);

    return { balances_root: balancesRoot, stakes_root: stakesRoot, state_root: stateRoot, block_merkle_root: blockMerkleRoot };
}

module.exports = {
    EMPTY_ROOT_HEX,
    DbNodeStore,
    MemoryNodeStore,
    PersistentSMT,
    assembleStateRoot,
    getNetBalance,
    gatherStakeEntries,
    computeBlockMerkleRoot,
    buildFullBalancesRoot,
    computeAndStoreRoots
};

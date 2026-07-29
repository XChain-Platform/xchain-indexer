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
 * contract_state_root derivation (SPV sub-tree spec §3 Stage A; design in
 * claude/specs/spv-state-subtree-extension.md).
 *
 * One SMT leaf per live (contract_index, state_key), keyed by
 * merkle.contractStateKey()'s XCHAIN_CST domain. This module owns the whole
 * row-to-leaf mapping and nothing else: the SMT engine, the node store and the
 * block paths stay in each repo's stateCommitment.js, which passes an `smt` in.
 * That is what lets this file be BYTE-IDENTICAL in xchain-indexer/src (SOURCE)
 * and xchain-sync/src (FOLLOWER), drift-guarded by the cross-repo twin loop in
 * xchain-sync/test/unit/rollback-coverage.test.js. The follower recomputes and
 * HALTs on divergence, so any drift here is a fleet halt rather than a fork,
 * and byte-identity is how it is prevented instead of detected.
 *
 * ---- THE TOUCHED-KEY CHANNEL, AND WHY THERE ISN'T ONE -------------------
 *
 * The design doc's §3-A item 1 expected this stage to build a write choke point
 * on the source (the equivalent of db._smtTouched, which balances uses) plus a
 * separate payload-derived touched set on the follower, plus a third derivation
 * on each twin's rollback path. None of that is needed, and building it would
 * have been three chances to disagree instead of one shared answer.
 *
 * contract_state is APPEND-ONLY and carries block_index with an index on it
 * (src/sql/contract_state.sql: idx_block). The table is therefore already its
 * own touched-key journal, and it is the SAME journal on both twins: the
 * follower replicates contract_state rows (tableLifecycle replication
 * 'stream:block') and ClientApplier inserts them before it calls the commitment
 * hook, exactly as the indexer writes them before computeAndStoreRoots. So
 * "which keys did block B touch" is one indexed query with one answer on both
 * sides, rather than two hand-maintained sets that must be proven equal.
 *
 * Rollback needs no repair path for the same structural reason. Reorg deletes
 * contract_state AND state_tree_roots rows >= the orphan height (both are
 * rollback:'block' in tableLifecycle.js) while state_tree_nodes is
 * copy-on-write and rollback-exempt, so the surviving fork-point row still
 * anchors a complete tree. The next computed block threads from block-1's
 * STORED contract_state_root, which is by construction the root of the chain
 * that survived. A key written only by an orphaned block reverts to its
 * pre-orphan leaf without anyone deriving a "keys to undo" set, because the
 * root it threads from never contained the orphaned write.
 *
 * ---- ROW-TO-LEAF MAPPING (frozen 2026-07-28 by the A0 run, ) ------
 *
 * 1. Latest row per (contract_index, state_key) by MAX(id), grouped on the
 *    BINARY collation, mirroring db.getContractState.
 * 2. MAX(id) runs over ALL rows INCLUDING tombstones, and only the winner is
 *    tested for NULL. This ordering is load-bearing and it is the one thing in
 *    this file most likely to be "cleaned up" into a fork: filtering
 *    state_value IS NOT NULL BEFORE taking the max resurrects every deleted key
 *    by selecting its last surviving write, committing state the VM does not
 *    have. It reads like a harmless predicate move. It is a fork.
 * 3. A NULL state_value on the winning row is the DELETION TOMBSTONE, not
 *    corruption: StateManager.delete() does dirty.set(key, null) and the
 *    indexer appends that as a SQL-NULL row. It maps to NO LEAF (an SMT
 *    delete), never leafHash(null) (which throws) and never leafHash('').
 * 4. Otherwise the leaf is leafHash(state_value) over the RAW STORED STRING,
 *    never the JSON.parse'd form. getContractState parses with a raw fallback
 *    on failure, so the parsed form is not a function of the row alone; the
 *    stored string is.
 * 5. state_value = '' commits leafHash(''), which is distinct from absent.
 *    Measured 0 rows fleet-wide and it looks unreachable through the VM (values
 *    are JSON.stringify'd, so an empty string stores as the two bytes ""), so
 *    this branch is defensive. It stays frozen anyway: an unreachable case left
 *    undefined becomes a fork the day it stops being unreachable.
 *
 * DIVERGENCE TO DOCUMENT, NOT TO HARMONIZE: the block-merkle path maps a NULL
 * state_value to '' via _c() in merkle.blockMerkleLeaves -> contractLeaf. That
 * is a DIFFERENT mapping from the tombstone-delete above, and both are correct
 * for what they commit. block_merkle_root is a content commitment over the
 * exact rows a block wrote, tombstones included; contract_state_root commits
 * LIVE state, from which a tombstoned key is absent. Making them agree would
 * fork one of the two.
 *
 * ---- TWO PRECONDITIONS THAT ARE INVISIBLE IN THE CODE -------------------
 *
 * a) NO FUTURE ROWS. latestStateValue takes the newest row for a key with no
 *    as-of-height filter, so a root may only ever be computed for the block
 *    currently being processed, while no higher block's rows exist. Every
 *    caller satisfies this (the indexer writes then commits inside the block
 *    txn; the follower applies then computes; a snapshot seeds at its own
 *    height), and the balances path has the identical property via
 *    getNetBalance. Recomputing a HISTORICAL block's root with later rows
 *    present would read the future and produce a root nobody else has.
 *
 * b) A NODE STORE THAT SPANS BLOCKS. The incremental thread descends the prior
 *    block's root through the persistent node store, and PersistentSMT._descend
 *    reads a missing node row as an EMPTY SUBTREE rather than failing. Hand it a
 *    store that does not carry the previous block's nodes and it silently
 *    rebuilds from a blank tree: the result still looks like a root, and only a
 *    comparison against a full build reveals it. state_tree_nodes is
 *    copy-on-write and rollback-exempt precisely so this holds across reorgs.
 *
 * ---- STRICT READS (M-17) -------------------------------------------------
 *
 * Every read here uses doQueryStrict, never doQuery. doQuery collapses a
 * NON-transactional query error into [], which is indistinguishable from a
 * genuinely empty result, and each of these reads has a different wrong answer
 * waiting behind that []:
 *
 *   touchedContractStateKeys -> [] means "this block touched nothing", so the
 *     root threads forward unchanged while every other node applies the block;
 *   latestStateValue         -> [] means "tombstone", so the key is DELETED
 *     from the tree instead of updated;
 *   buildFullContractStateRoot -> [] means the EMPTY root is committed over a
 *     populated table.
 *
 * All three are silent forks on this node alone. Inside the block transaction
 * doQuery already re-throws, so the two are equivalent there; outside one
 * (seedSnapshotRoots, tooling) they are not, and that is precisely where this
 * module runs untransacted. A throw halts the node instead, which the block
 * retry then clears if the fault was transient.
 *
 * The prior-root read is the one case where [] is survivable (it degrades to a
 * full build, which is correct but expensive). It is strict anyway: a reader
 * that is strict everywhere cannot be made soft by a later edit moving a query
 * from one function to another.
 *
 * ---- COLLATION -----------------------------------------------------------
 *
 * Every query here groups and matches on state_key_bin, the utf8_bin generated
 * shadow of state_key. contract_state itself is utf8_general_ci, so a plain
 * DISTINCT/GROUP BY on state_key folds "Key" and "key" into one row and the SMT
 * would be built over a folded key set: a fork against any node reading the
 * binary collation. Depending on state_key_bin is safe because Stage A may
 * never arm below a chain's state_key_collation height (spec §3-A hard
 * precondition 1), which is the same column db.getContractState switches to.
 *
 **********************************************************************/

'use strict';

const M = require('./merkle.js');

const EMPTY_ROOT_HEX = M.toHex(M.EMPTY_SMT_ROOT);

// Mapping rules 3-5. Returns the value-leaf hex, or null meaning "no leaf"
// (delete the key from the tree). NULL and undefined collapse deliberately: a
// tombstoned key and a key with no row at all are both absent from live state,
// so they must commit the same thing.
function contractStateLeaf(stateValue){
    if(stateValue === null || stateValue === undefined) return null;
    return M.toHex(M.leafHash(String(stateValue)));
}

// Distinct keys written by one block: the touched set, straight off the journal.
// state_key_bin is both grouped AND selected, so the returned text is the exact
// key bytes rather than a case-folded representative of a group.
async function touchedContractStateKeys(db, blockIndex){
    const rows = await db.doQueryStrict(
        'SELECT DISTINCT contract_index AS contract_index, state_key_bin AS state_key ' +
        'FROM contract_state WHERE block_index = ?',
        [blockIndex]);
    return (rows || []).map(r => ({ contract_index: r.contract_index, state_key: r.state_key }));
}

// Winning row for one key: MAX(id) over ALL rows, tombstones included (mapping
// rule 2). Returns the raw stored state_value, or null for "no row" / tombstone.
// ORDER BY id DESC LIMIT 1 is the index-backed spelling of MAX(id) here
// (idx_latest_bin is (contract_index, state_key_bin, id DESC)).
async function latestStateValue(db, contractIndex, stateKey){
    const rows = await db.doQueryStrict(
        'SELECT state_value FROM contract_state ' +
        'WHERE contract_index = ? AND state_key_bin = ? ORDER BY id DESC LIMIT 1',
        [contractIndex, stateKey]);
    return (rows && rows.length) ? rows[0].state_value : null;
}

// Full build over the entire live contract-state set. Used at the arming block,
// on a snapshot bootstrap, and whenever the prior root is unavailable. The
// tombstone filter is applied in JS, AFTER the MAX(id) join, so rule 2's
// ordering holds here exactly as it does on the incremental path and the
// mapping lives in one function rather than being half in SQL.
//
// Cost: one pass over the live key set (per-contract keys are capped by the
// VM's maxStateKeys; contract count is not). Measuring this on the largest
// testnet set is spec §3-A item 6, before any mainnet height is set.
async function buildFullContractStateRoot(db, smt, chain, network){
    const rows = await db.doQueryStrict(
        'SELECT cs.contract_index AS contract_index, cs.state_key_bin AS state_key, ' +
        '       cs.state_value AS state_value ' +
        'FROM contract_state cs ' +
        'INNER JOIN ( ' +
        '    SELECT MAX(id) AS max_id FROM contract_state GROUP BY contract_index, state_key_bin ' +
        ') latest ON cs.id = latest.max_id',
        []);
    let root = EMPTY_ROOT_HEX;
    for(const r of (rows || [])){
        const leaf = contractStateLeaf(r.state_value);
        if(leaf == null) continue;   // tombstoned: absent from live state, so absent from the tree
        root = await smt.update(root, M.contractStateKey(chain, network, r.contract_index, r.state_key), leaf);
    }
    return root;
}

// The root for one block: thread incrementally from the prior block's stored
// root, or full-build when there is no prior root to thread from.
//
// A missing prior root is not an error case, it is FOUR legitimate cases with
// one correct response:
//   - the arming block (block-1 committed EMPTY and stored NULL);
//   - a snapshot bootstrap (no block-1 row at all);
//   - a reorg that rolled the arming height below this block and re-advanced;
//   - a node that ran a build without the derivation and is now catching up.
// A full build is correct for every one of them because it derives the root
// from the current live key set alone, independent of any prior root. The
// alternative, threading from the empty root, silently emits a
// contract_state_root forked from a from-genesis node: the exact failure the
// balances path already refuses to make.
async function resolveContractStateRoot(db, smt, chain, network, blockIndex, shadow){
    // Two columns, one derivation. While a chain is only SHADOWING (spec §7) the
    // committed column is NULL by definition, so threading from it would full-build
    // every single block and the shadow window would cost more than the flag day it
    // is de-risking. The shadow threads through its own column instead. The two are
    // never mixed: isSubtreeShadowActive answers false once a slot is really armed,
    // so each height uses exactly one column, and the arming block deliberately
    // full-builds (its committed column has no predecessor) rather than inheriting
    // a value from the shadow run.
    const prior = await db.doQueryStrict(shadow
        ? 'SELECT contract_state_root_shadow AS r FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1'
        : 'SELECT contract_state_root AS r FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1',
        [chain, network, blockIndex - 1]);
    const priorRoot = (prior && prior.length && prior[0].r) ? String(prior[0].r) : null;
    if(priorRoot == null)
        return await buildFullContractStateRoot(db, smt, chain, network);

    let root = priorRoot;
    for(const t of await touchedContractStateKeys(db, blockIndex)){
        const leaf = contractStateLeaf(await latestStateValue(db, t.contract_index, t.state_key));
        root = await smt.update(root, M.contractStateKey(chain, network, t.contract_index, t.state_key), leaf);
    }
    return root;
}

module.exports = {
    EMPTY_ROOT_HEX,
    contractStateLeaf,
    touchedContractStateKeys,
    latestStateValue,
    buildFullContractStateRoot,
    resolveContractStateRoot
};

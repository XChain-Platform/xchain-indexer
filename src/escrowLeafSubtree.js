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
 * XCHAIN_ESC locked-balance leaf derivation (SPV sub-tree spec §3 Stage B;
 * design in claude/specs/spv-state-subtree-extension.md).
 *
 * NOT A SUB-ROOT. Stage A committed a new top-level slot; this commits a second
 * LEAF DOMAIN inside the EXISTING balances_root, beside the spendable-balance
 * leaf, under merkle.escrowKey()'s XCHAIN_ESC tag. That is why arming it is
 * sequenced after Stage A and treated more carefully: it moves the one sub-root
 * every deployed light client already depends on, where Stage A only lit a slot
 * that was empty. Existing XCHAIN_BAL proofs stay valid (different key domain),
 * so no deployed client breaks, but every balances_root at an armed height
 * changes.
 *
 * READS THE JOURNAL, NEVER THE LIVE TABLES. `escrow_leaf_journal` holds each
 * locker's own total, computed once by the source when a block changed it (see
 * src/sql/escrow_leaf_journal.sql for why the `escrows` ledger cannot answer
 * this question, and why recomputing at read time would mean a second
 * implementation of four families' open-remaining logic inside a consensus
 * surface). Because the journal is append-only with a block_index, this module
 * is a near-copy of contractStateSubtree.js and inherits its proven properties:
 * the touched set is one indexed query with one answer on both twins, rollback
 * needs no repair pass, and as-of-height reads are the latest row at or below H.
 *
 * BYTE-IDENTICAL TWIN: xchain-indexer/src/escrowLeafSubtree.js (SOURCE) and
 * xchain-sync/src/escrowLeafSubtree.js (FOLLOWER), drift-guarded by the
 * cross-repo twin loop in xchain-sync/test/unit/rollback-coverage.test.js. The
 * follower recomputes balances_root and HALTs on divergence, so drift here is a
 * fleet halt rather than a fork.
 *
 * ---- ROW-TO-LEAF MAPPING -------------------------------------------------
 *
 * 1. Latest journal row per (address, tick) by MAX(id).
 * 2. MAX(id) runs over ALL rows INCLUDING tombstones, and only the winner is
 *    tested. Filtering non-tombstones BEFORE the max resurrects every released
 *    lock at its last positive value. Identical trap to Stage A's, identical
 *    answer, and it is worth re-reading the note in contractStateSubtree.js.
 * 3. DELETE-ON-ZERO, and here it is broader than Stage A's tombstone rule
 *    because a locked total legitimately REACHES zero: a NULL locked_amount and
 *    a canonical zero are the SAME answer, no leaf. Committing
 *    leafHash(canonicalAmount('0')) instead would fork the twins on the first
 *    fully-filled order, which is why the parent spec makes delete-on-zero
 *    normative for XCHAIN_BAL and this carries it to XCHAIN_ESC unchanged.
 * 4. Otherwise the leaf is amountLeaf(locked_amount), the same amount encoding
 *    the spendable leaf uses, so a client verifies both leaves the same way.
 *
 * A negative total is a BUG, not a state: canonicalAmount rejects it and the
 * throw is deliberate. It would mean the writer released more than was locked,
 * which is exactly the condition the reconciliation invariant exists to catch,
 * and committing it is worse than halting on it.
 *
 * ---- STRICT READS (M-17) -------------------------------------------------
 *
 * Every read here uses doQueryStrict, never doQuery, for the reason spelled out
 * at length in contractStateSubtree.js: doQuery collapses a NON-transactional
 * query error into [], and an empty result is a MEANINGFUL answer at every one
 * of these call sites rather than an error signal.
 *
 *   touchedEscrowKeys    -> [] means "no locker moved in this block", so the
 *     tree threads forward while the rest of the fleet applies the changes;
 *   latestLockedAmount   -> [] means "nothing locked", which is delete-on-zero,
 *     so the leaf is REMOVED instead of updated;
 *   liveEscrowLeaves     -> [] means a full balances rebuild that silently drops
 *     every locked leaf, which is the quiet fork spec §3-B item 2 names;
 *   the shadow prior-root read degrades to a full build, survivable, strict
 *     anyway for the same uniformity reason Stage A gives.
 *
 * latestLockedAmount's asOfBlock branch is the as-of-height proof read. The
 * explorer does not route through it (it has its own copy in db.js, over a
 * doQuery that already throws unconditionally), so this branch has no
 * production caller today. It is strict for when one arrives: served outside a
 * transaction, a fail-soft [] there is a verifying NON-INCLUSION proof for a
 * key that is in fact locked, which is a worse outcome than an error.
 *
 **********************************************************************/

'use strict';

const M = require('./merkle.js');

const ZERO_CANON = M.canonicalAmount('0');

// Mapping rules 3-4. Returns the value-leaf hex, or null meaning "no leaf"
// (delete the key). NULL, undefined and canonical zero all collapse to null:
// nothing locked is nothing locked, however it was spelled.
function escrowLeaf(lockedAmount){
    if(lockedAmount === null || lockedAmount === undefined || lockedAmount === '') return null;
    const canon = M.canonicalAmount(String(lockedAmount));   // throws on negative, deliberately
    if(canon === ZERO_CANON) return null;
    return M.toHex(M.leafHash(canon));
}

// Distinct (address, tick) keys whose locked total changed in one block: the
// touched set, straight off the journal. Canonical strings, never surrogate ids,
// because the SMT key is derived from the strings (BLOCK_HASH_VERSION's
// id-independence rule) and the two twins must not depend on id assignment.
async function touchedEscrowKeys(db, blockIndex){
    const rows = await db.doQueryStrict(
        'SELECT DISTINCT a.address AS address, t.tick AS tick ' +
        'FROM escrow_leaf_journal j ' +
        'INNER JOIN index_addresses a ON a.id = j.address_id ' +
        'INNER JOIN index_tickers   t ON t.id = j.tick_id ' +
        'WHERE j.block_index = ?',
        [blockIndex]);
    return (rows || []).map(r => ({ address: r.address, tick: r.tick }));
}

// Winning journal row for one key: MAX(id) over ALL rows, tombstones included
// (mapping rule 2). `asOfBlock` bounds the read to a historical height for proof
// serving; omit it during block processing, where no higher row exists yet.
// ORDER BY id DESC LIMIT 1 is the index-backed spelling of MAX(id) here
// (idx_latest is (address_id, tick_id, id DESC)).
async function latestLockedAmount(db, address, tick, asOfBlock){
    const bounded = (asOfBlock !== undefined && asOfBlock !== null);
    const rows = await db.doQueryStrict(
        'SELECT j.locked_amount AS locked_amount ' +
        'FROM escrow_leaf_journal j ' +
        'INNER JOIN index_addresses a ON a.id = j.address_id ' +
        'INNER JOIN index_tickers   t ON t.id = j.tick_id ' +
        'WHERE a.address = ? AND t.tick = ?' + (bounded ? ' AND j.block_index <= ?' : '') +
        ' ORDER BY j.id DESC LIMIT 1',
        bounded ? [address, tick, asOfBlock] : [address, tick]);
    return (rows && rows.length) ? rows[0].locked_amount : null;
}

// Every live locked leaf, for the full balances rebuild. Mirrors the MAX(id)
// join shape exactly, with the tombstone filter applied in JS so the mapping
// lives in escrowLeaf() alone and cannot drift between the two paths.
async function liveEscrowLeaves(db){
    const rows = await db.doQueryStrict(
        'SELECT a.address AS address, t.tick AS tick, j.locked_amount AS locked_amount ' +
        'FROM escrow_leaf_journal j ' +
        'INNER JOIN ( ' +
        '    SELECT MAX(id) AS max_id FROM escrow_leaf_journal GROUP BY address_id, tick_id ' +
        ') latest ON j.id = latest.max_id ' +
        'INNER JOIN index_addresses a ON a.id = j.address_id ' +
        'INNER JOIN index_tickers   t ON t.id = j.tick_id',
        []);
    const out = [];
    for(const r of (rows || [])){
        const leaf = escrowLeaf(r.locked_amount);
        if(leaf == null) continue;                 // released: absent from the tree
        out.push({ address: r.address, tick: r.tick, leaf: leaf });
    }
    return out;
}

// Apply this block's escrow-leaf changes to a balances tree, returning the new
// root. Called by the balances block path ONLY when the escrow leaf is active at
// this height; below an armed height it is never reached and balances_root keeps
// its v1 leaf set exactly.
async function applyEscrowLeaves(db, smt, rootHex, chain, network, blockIndex){
    let root = rootHex;
    for(const k of await touchedEscrowKeys(db, blockIndex)){
        const leaf = escrowLeaf(await latestLockedAmount(db, k.address, k.tick));
        root = await smt.update(root, M.escrowKey(chain, network, k.address, k.tick), leaf);
    }
    return root;
}

// Shadow-compute window (SPV sub-tree spec §7 step 1, Stage B). The WOULD-BE
// balances_root at a height where the escrow leaf is NOT committed: spendable
// leaves exactly as the committed root applied them, plus this block's locked
// leaves from the journal. Threads through its OWN column
// (state_tree_roots.balances_root_escrow_shadow), never the committed one,
// exactly as the contract-state shadow threads through its own: the committed
// balances_root is live consensus data the follower compares every block, so a
// would-be value there is either a false halt or a proof outage.
//
// `balanceUpdates` is this block's spendable-leaf update list ([{key, leaf}],
// key a Buffer, leaf hex or null), derived by the CALLER with the same
// mechanism it used for the committed root. That is what keeps this module a
// byte-identical twin: the source derives touched balances from its write
// choke point and the follower from the applied payload, and neither
// derivation belongs here. Pass null when the committed path did a full
// recompute (no per-key list exists); the shadow then full-builds too.
//
// `fullBuild` is the caller's height-aware full rebuild, invoked with escrow
// leaves FORCED ON, for the same four no-prior cases the committed thread
// full-builds for (window start, snapshot bootstrap, reorg below the window,
// catch-up). ARMED WINS is the caller's job: this is only reached while the
// leaf is shadow-active, never at armed heights.
async function resolveShadowBalancesRoot(db, smt, chain, network, blockIndex, balanceUpdates, fullBuild){
    const prior = await db.doQueryStrict(
        'SELECT balances_root_escrow_shadow AS r FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1',
        [chain, network, blockIndex - 1]);
    const priorRoot = (prior && prior.length && prior[0].r) ? String(prior[0].r) : null;
    if(priorRoot == null || balanceUpdates == null)
        return await fullBuild();
    let root = priorRoot;
    for(const u of balanceUpdates)
        root = await smt.update(root, u.key, u.leaf);
    return await applyEscrowLeaves(db, smt, root, chain, network, blockIndex);
}

module.exports = {
    escrowLeaf,
    touchedEscrowKeys,
    latestLockedAmount,
    liveEscrowLeaves,
    applyEscrowLeaves,
    resolveShadowBalancesRoot
};

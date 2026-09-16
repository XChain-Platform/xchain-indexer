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
 * fuzz test (test/unit/state_commitment/state_commitment.test.js) lock the equality; the xchain-sync
 * follower keeps its own byte-identical copy and HALTS on divergence.
 *
 * The derivations the block commitment composes live beside this file as named
 * parts: this directory holds the leaf values, stakes_root, state_root and
 * block_merkle_root, the full balances build, the two completeness guards and,
 * in persistent_smt.js, the node stores, the SMT engine and the orphan
 * observability walk (the three blocks xchain-sync carries as byte twins, with
 * the node model documented at their head); db/state_commitment/ holds the
 * ledger reads and the state_tree_roots row. What stays here is the per-block
 * orchestration whose source the frozen twin suites and the flag-day deploy
 * check read by this path, and the export surface every requirer imports, so
 * the engine classes are re-exported from the part unchanged.
 *
 ********************************************************************/

'use strict';

const M = require('../consensus/merkle.js');
const SUB = require('../state_subtree_activation.js');
const CST = require('../consensus/contract_state_subtree.js');
const ESC = require('../consensus/escrow_leaf_subtree.js');
const EJW = require('../consensus/escrow_journal_writer.js');   // SOURCE ONLY: the follower replicates these rows
const { getLogger } = require('../observability/index.js');
const { leafOrNull } = require('./leaf_values.js');
const { gatherStakeEntries, buildStakesRoot, resetStakesMemo } = require('./stakes_root.js');
const { assembleStateRoot, extraSubRootColumn, computeBlockMerkleRoot } = require('./state_root.js');
const FULL = require('./full_balances_root.js');
const { enforceTouchedSet, assertCommittedLeaves } = require('./touch_guards.js');
const { getNetBalance } = require('../db/state_commitment/ledger_reads.js');
const { getPriorBalancesRoot, storeStateTreeRoots } = require('../db/state_commitment/roots.js');
const PSMT = require('./persistent_smt.js');
const { EMPTY_ROOT_HEX, DbNodeStore, MemoryNodeStore, PersistentSMT, reportOrphanStats } = PSMT;

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

// The full balances_root build (full_balances_root.js beside this file) over a
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
// aggregates or status predicates (see escrow_journal_writer.js for why).
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
    const prior = isActivationBlock ? [] : await getPriorBalancesRoot(db, chain, network, blockIndex - 1);
    // The ARMING BLOCK full-builds too. The incremental branch applies
    // escrow leaves from touchedEscrowKeys(armingBlock), i.e. only journal rows
    // stamped at THIS height, while the arming replay deliberately writes no row for
    // a key whose total is unchanged (escrow_journal_writer.js `if(eq(prior,next))
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
// both completeness guards (touch_guards.js beside this file) on the result.
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
// assembly, the shadow value and the row write stay together in this file: the
// frozen twin suites read this path to prove every assembleStateRoot call takes
// only gated sub-roots and that the shadow value never reaches a committed
// column. The INSERT text itself is db/state_commitment/roots.js
// storeStateTreeRoots, which takes the finished values and nothing else.
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

    await storeStateTreeRoots(db, chain, network, blockIndex,
        [balancesRoot, stakesRoot, stateRoot, blockMerkleRoot, contractStateRoot, contractStateShadow, balancesEscrowShadow]);

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

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
 * XChain Indexer - State commitment part: balances_root completeness guards
 *
 * The two checks the incremental balances_root thread runs before its root is
 * committed: the touched-set guard and the post-commit leaf-presence assertion.
 * Part of the block commitment that src/state_commitment/index.js orchestrates, which
 * calls both on its incremental branch only.
 *
 ********************************************************************/

'use strict';

const M = require('../consensus/merkle.js');
const { getLogger } = require('../observability/index.js');
const { canonicalAmountOf, leafOrNull } = require('./leaf_values.js');
const { getNetBalance, ledgerKeysForBlock } = require('../db/state_commitment/ledger_reads.js');
const { readEnvNow } = require('../config.js'); // per call, never a load-time snapshot: a running node flips these guards

// ---- Touched-set guard ------------------------------------------------------
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
// leafOrNull maps 0 to null, and the commitment deletes a key that never
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
//     escrows, while the expected set (ledgerKeysForBlock) reads credits and debits only, so an
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
async function enforceTouchedSet(db, blockIndex, touched){
    const expected = await ledgerKeysForBlock(db, blockIndex);
    if(!expected.size) return;

    const applied = new Set(touched);
    const missing = [...expected].filter(k => !applied.has(k));

    if(readEnvNow('INDEXER_SMT_TOUCH_AUDIT') === '1'){
        const extra = [...applied].filter(k => !expected.has(k));
        if(extra.length)
            getLogger().info('SMT-TOUCH-AUDIT block=' + blockIndex +
                ' extra=' + JSON.stringify(extra.map(k => k.split('\t'))));
    }

    if(!missing.length) return;

    const detail = JSON.stringify(missing.map(k => k.split('\t')));
    const msg = 'balances touched-set guard FAILED at block ' + blockIndex +
        ': the ledger moved ' + missing.length + ' key(s) the commitment did not apply, so ' +
        'balances_root would be committed incomplete. keys=' + detail +
        ' (balances-root leaf-completeness guard)';
    if(readEnvNow('INDEXER_TOUCH_GUARD') === 'warn'){
        getLogger().error(msg + ' [INDEXER_TOUCH_GUARD=warn: COMMITTING ANYWAY, this node will ' +
            'diverge from any node that full-rebuilds]');
        return;
    }
    throw new Error(msg);
}

// ---- Post-commit leaf-presence assertion -------------------------------------
//
// The touched-set guard above compares SET MEMBERSHIP in both directions, and
// the missing-leaf fault class is not a membership failure. The key IS touched
// and IS in `applied`; getNetBalance then answers 0 for it, leafOrNull maps 0 to
// null, and the commitment DELETES a key that never existed. `missing` is empty,
// nothing throws, nothing logs, and the leaf never lands. That was PROVEN on a
// replay venue: with the guard live and the audit armed, block 103
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
// the after-the-fact per-key sweep produced four spurious hits from today's balance and
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
async function assertCommittedLeaves(db, smt, chain, network, blockIndex, balancesRootHex){
    const expected = await ledgerKeysForBlock(db, blockIndex);
    if(!expected.size) return;

    const absent = [];
    for(const entry of expected){
        const [address, tick] = entry.split('\t');
        const proof = await smt.prove(balancesRootHex, M.balanceKey(chain, network, address, tick));
        if(proof.leaf_value != null) continue;               // the leaf landed
        const net = await getNetBalance(db, address, tick);
        if(leafOrNull(net) == null) continue;                // net-zero: no leaf by design
        absent.push([address, tick, canonicalAmountOf(net)]);
    }
    if(!absent.length) return;

    const msg = 'balances leaf-presence assertion FAILED at block ' + blockIndex + ': ' +
        absent.length + ' key(s) the ledger moved have NO leaf in the committed balances_root ' +
        'while their net is non-zero, so balances_root would be committed incomplete. ' +
        'keys=' + JSON.stringify(absent) + ' (leaf-presence guard)';
    if(readEnvNow('INDEXER_TOUCH_GUARD') === 'warn'){
        getLogger().error(msg + ' [INDEXER_TOUCH_GUARD=warn: COMMITTING ANYWAY, this node will ' +
            'diverge from any node that full-rebuilds]');
        return;
    }
    throw new Error(msg);
}

module.exports = {
    enforceTouchedSet,
    assertCommittedLeaves
};

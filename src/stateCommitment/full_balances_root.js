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
 * XChain Indexer - State commitment part: full balances_root build
 *
 * The from-scratch balances_root over every nonzero net, plus the XCHAIN_ESC
 * locked leaves once they arm. Part of the block commitment that
 * src/stateCommitment.js orchestrates; its buildFullBalancesRoot supplies the
 * persistent SMT this build writes through.
 *
 ********************************************************************/

'use strict';

const M      = require('../consensus/merkle.js');
const SUB    = require('../state_subtree_activation.js');
const ESC    = require('../consensus/escrow_leaf_subtree.js');
const LEDGER = require('../db/state_commitment/ledger_reads.js');
const { leafOrNull } = require('./leaf_values.js');

// Root of an empty depth-256 SMT: the same value src/stateCommitment.js exports
// as EMPTY_ROOT_HEX, derived here from merkle.js rather than required back from
// the module that requires this one.
const EMPTY_ROOT_HEX = M.toHex(M.EMPTY_SMT_ROOT);

// Locked-escrow leaf (XCHAIN_ESC): BUILT and gated, no longer deferred (SPV
// sub-tree spec §3 Stage B). The finding that killed the naive derivation
// still stands and is why the journal exists: the escrows
// table keys a lock (+amount) to the order SOURCE but keys nine release sites
// to the recipient, so SUM(escrows) per (address, tick) does NOT net per key
// and only the per-tick GLOBAL sum nets to zero. The journal writer
// (escrowJournalWriter.js) re-keys those rows to their locker at write time;
// escrow_leaf_subtree.js derives the leaves from the journal, applied inside
// balances_root when ESCROW_LOCKED_LEAF_ACTIVATION arms a height (and into
// the shadow column while ESCROW_LOCKED_LEAF_SHADOW does). Until then
// balances_root commits ONLY the net-spendable leaf, byte-identical to v1.

// ---- Full balances-tree initialization (flag-day cutover, §4.3) -------------
// One-time at the activation boundary block: seed the balances SMT from ALL
// pre-existing nonzero net balances (escrow leaf deferred from v1, see note
// above). (At genesis activation this is just the boundary block's own
// effects.) Persists nodes through `smt`, a PersistentSMT over the block's
// node store.
async function buildFullBalancesRootWith(smt, db, chain, network, blockIndex, opts){
    let root = EMPTY_ROOT_HEX;
    const bals = await LEDGER.getNonzeroNetBalances(db);
    for(const r of bals){
        if(r.address == null || r.tick == null) continue;
        const leaf = leafOrNull(r.net);
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

module.exports = {
    buildFullBalancesRootWith
};

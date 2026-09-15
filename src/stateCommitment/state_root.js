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
 * XChain Indexer - State commitment part: state_root and block_merkle_root
 *
 * The two per-block roots assembled from inputs rather than threaded through
 * the persistent SMT: the top-level state_root over the gated sub-roots, and
 * the block-content Merkle root over the block's canonical rows. Part of the
 * block commitment that src/stateCommitment.js orchestrates; the one call site
 * that hands assembleStateRoot its gated sub-roots stays in that file, where
 * the frozen twin suites pin it by path.
 *
 ********************************************************************/

'use strict';

const M   = require('../consensus/merkle.js');
const SUB = require('../state_subtree_activation.js');

// Assemble the top-level state_root from the two v1 sub-roots plus any RESERVED
// slot that its flag-day has armed (SPV spec §4.1, state-subtree extension design).
//
// `extraSubRoots` is the forward-compatible carrier for ownership_root /
// tokens_root / contract_state_root and MUST be the output of
// state_subtree_activation.gateSubRoots(), never a caller's raw candidates: the
// gate is what keeps an un-armed slot EMPTY. It is null today (every slot inert),
// and merkle.stateRoot() maps a null/absent/empty-root slot to the identical
// EMPTY_SMT_ROOT leaf, so this is byte-identical to the old two-argument
// assembly on every chain. The equality is asserted, not assumed, in
// test/unit/state_subtree_activation.test.js.
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

module.exports = {
    assembleStateRoot,
    extraSubRootColumn,
    computeBlockMerkleRoot
};

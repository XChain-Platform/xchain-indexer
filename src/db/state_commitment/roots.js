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
 * XChain Indexer - Database part: the state_tree_roots row
 *
 * The two statements the per-block commitment issues against state_tree_roots:
 * the prior block's balances_root, which the incremental thread starts from,
 * and the block's own row write. Plain functions over a db handle rather than
 * a mixin, for the same reason as ledger_reads.js beside this file: the
 * commitment is driven by unit mocks that implement only doQueryStrict and by
 * the bin/ replay tools, neither of which installs the Database prototype.
 *
 * Both are strict (doQueryStrict). A fail-soft [] on the prior-root read would
 * degrade every block into a full rebuild, and a swallowed row write would leave
 * the next block with no root to thread from; see the M-17 note at the head of
 * DbNodeStore in src/state_commitment/persistent_smt.js.
 *
 ********************************************************************/

'use strict';

// The prior block's committed balances_root, or [] when that height has no
// row (activation boundary, snapshot bootstrap, or a reorg that rolled the row
// away). The caller decides what an empty answer means; this only reads.
async function getPriorBalancesRoot(db, chain, network, priorBlockIndex){
    return db.doQueryStrict(
        'SELECT balances_root FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1',
        [chain, network, priorBlockIndex]);
}

// Write one block's roots row. `roots` is the finished value list in column
// order: balances_root, stakes_root, state_root, block_merkle_root,
// contract_state_root, contract_state_root_shadow, balances_root_escrow_shadow.
// ON DUPLICATE KEY UPDATE rewrites every value column from the same statement,
// so a reorg replay or self-heal at a height that already has a row can never
// leave a column stale against its own state_root.
async function storeStateTreeRoots(db, chain, network, blockIndex, roots){
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
        [chain, network, blockIndex, ...roots]);
}

module.exports = {
    getPriorBalancesRoot,
    storeStateTreeRoots
};

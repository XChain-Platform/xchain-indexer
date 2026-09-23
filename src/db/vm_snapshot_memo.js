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
 * XChain Indexer - Per-block memo for the VM snapshot builders
 *
 * The cross-chain and poll snapshots read only rows below the block in progress, and
 * every write a block makes is stamped with that block, so the snapshot for a bound at
 * or below it cannot change while the block runs. The block pass installs a fresh memo
 * (db._vmSnapshotMemo) when it opens the block's transaction and drops it when the pass
 * ends, so each snapshot is built once per block instead of once per execution.
 *
 ********************************************************************/

// Freeze a snapshot and everything under it, so no caller can leak a mutation into the
// next execution served the same object.
function deepFreeze(value){
    if(value === null || typeof value !== 'object' || Object.isFrozen(value))
        return value;
    for(let key of Object.keys(value))
        deepFreeze(value[key]);
    return Object.freeze(value);
}

// Serve the snapshot for `key` from the block pass's memo, building it on first use.
// Builds fresh outside a block pass and for a bound past the block in progress, where
// rows the block is still writing would fall inside the read.
async function memoizedVmSnapshot(db, key, bound, build){
    let memo = db._vmSnapshotMemo;
    if(!(memo instanceof Map) || !(bound <= Number(db.blockIndex)))
        return build();
    if(memo.has(key))
        return memo.get(key);
    let snapshot = deepFreeze(await build());
    memo.set(key, snapshot);
    return snapshot;
}

module.exports = { memoizedVmSnapshot, deepFreeze };

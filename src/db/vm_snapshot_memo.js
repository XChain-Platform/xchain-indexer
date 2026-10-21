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

// Cross-block cache. A snapshot for a bound reads only rows below that bound, and every
// later block stamps its writes at or above its own height, so a snapshot built at one
// block stays right for the next ones until a rollback rewrites rows below its bound. The
// cache lives on db._vmSnapshotCache (the block pass does not drop it) and remembers the
// last applied block it has seen, so a rollback that never called invalidate() is still
// caught: the block index going backwards flushes everything.
const CROSS_BLOCK_MAX_ENTRIES = 64;

function crossBlockCache(db){
    let cache = db._vmSnapshotCache;
    if(!cache){
        cache = { lastBlock: null, entries: new Map() };
        db._vmSnapshotCache = cache;
    }
    let tip = Number(db.blockIndex);
    // A dropped invalidation: the tip moved back below the last block the cache served
    // without invalidate(fromBlock) being called, so nothing in it can be trusted.
    if(cache.lastBlock !== null && tip < cache.lastBlock)
        cache.entries.clear();
    cache.lastBlock = tip;
    return cache;
}

// Drop every cached snapshot a rollback of blocks fromBlock and up can have changed: those
// whose bound is above fromBlock, since they read rows stamped fromBlock.
function invalidate(db, fromBlock){
    let cache = db._vmSnapshotCache;
    if(!cache)
        return 0;
    let dropped = 0;
    for(let [key, entry] of cache.entries){
        if(entry.bound > Number(fromBlock)){
            cache.entries.delete(key);
            dropped++;
        }
    }
    if(cache.lastBlock !== null && cache.lastBlock >= Number(fromBlock))
        cache.lastBlock = Number(fromBlock) - 1;
    return dropped;
}

// Serve the snapshot for `key` from the block pass's memo, then the cross-block cache,
// building it on first use. Builds fresh outside a block pass and for a bound past the
// block in progress, where rows the block is still writing would fall inside the read.
async function memoizedVmSnapshot(db, key, bound, build){
    let memo = db._vmSnapshotMemo;
    if(!(memo instanceof Map) || !(bound <= Number(db.blockIndex)))
        return build();
    if(memo.has(key))
        return memo.get(key);
    let cache = crossBlockCache(db);
    let hit = cache.entries.get(key);
    if(hit && hit.bound === Number(bound)){
        memo.set(key, hit.snapshot);
        return hit.snapshot;
    }
    let snapshot = deepFreeze(await build());
    memo.set(key, snapshot);
    cache.entries.delete(key);
    cache.entries.set(key, { bound: Number(bound), snapshot });
    if(cache.entries.size > CROSS_BLOCK_MAX_ENTRIES)
        cache.entries.delete(cache.entries.keys().next().value);
    return snapshot;
}

module.exports = { memoizedVmSnapshot, deepFreeze, invalidate };

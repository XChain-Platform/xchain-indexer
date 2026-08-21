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
 * PersistentSMT node reads are CACHED, and the caching changes
 * nothing but the round-trip count.
 *
 * The write half of this shape was fixed first (see
 * stateCommitment.batchedNodeWrites.test.js): one key update writes SMT_DEPTH
 * rows, which as one statement per row was 12,544 round trips and 25-66s per
 * block on the BTC regtest venue. The READ half stayed unbatched and uncached.
 * _descend walks the key path with one dependent point SELECT per level, and a
 * present key's ancestors are never an empty subtree, so a descent never
 * short-circuits: SMT_DEPTH sequential reads, paid once in update() and again
 * in the prove() that _assertCommittedLeaves runs back over the same keys, plus
 * SMT_DEPTH per key on every buildFull rebuild.
 *
 * Three properties:
 *   1. EQUIVALENCE - the cached engine emits the identical root and the
 *      identical node set as an uncached one. This is the consensus guard: the
 *      cache is a transport fix, so a moved root is a fork.
 *   2. READ COUNT - a prove() over a key this instance just wrote costs ZERO
 *      store reads, and a buildFull over the measured 49-key stakes subtree
 *      costs a small fraction of the uncached count. Reverting the cache
 *      reddens this and only this.
 *   3. POSITIVE ENTRIES ONLY - a store MISS is never cached. Absence is the
 *      fail-loud signal the strict-read design depends on, so an absent node
 *      must keep reaching the store on every ask.
 *
 * No DB required: the counting store implements the same interface as
 * DbNodeStore.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const M  = require('../../src/merkle.js');
const SC = require('../../src/stateCommitment.js');

function keyFor(i){ return M.sha256(Buffer.from('xc-smt-read-cache:' + i, 'utf8')); }
function leafFor(i){ return M.toHex(M.amountLeaf(String(i * 7 + 2) + '.00000000')); }

// Answers like MemoryNodeStore but counts READ calls, so "one round trip per
// level" is measurable rather than argued.
class ReadCountingStore {
    constructor(){
        this.map      = new Map();
        this.getCalls = 0;
    }
    async get(h){
        this.getCalls++;
        return this.map.has(h) ? this.map.get(h) : null;
    }
    async put(h, l, r){ if(!this.map.has(h)) this.map.set(h, { left_hash: l, right_hash: r }); }
    async putMany(nodes){ for(const n of nodes) await this.put(n.hash, n.left, n.right); }
}

describe('stateCommitment: cached SMT node reads @regression', function(){

    it('caching emits the SAME root and the SAME node set as an uncached engine', async function(){
        const entries = [];
        for(let i = 0; i < 60; i++) entries.push([M.toHex(keyFor(i)), leafFor(i)]);

        const cached   = new ReadCountingStore();
        const uncached = new ReadCountingStore();
        const rootCached   = await new SC.PersistentSMT(cached).buildFull(entries);
        const rootUncached = await new SC.PersistentSMT(uncached, { nodeCacheMax: 0 }).buildFull(entries);

        assert.strictEqual(rootCached, rootUncached, 'caching changed the root: this is a consensus fork');
        assert.strictEqual(cached.map.size, uncached.map.size, 'caching changed the persisted node count');
        for(const [hash, row] of uncached.map){
            const got = cached.map.get(hash);
            assert.ok(got, 'cached store is missing node ' + hash);
            assert.strictEqual(got.left_hash,  row.left_hash,  'left child diverged at ' + hash);
            assert.strictEqual(got.right_hash, row.right_hash, 'right child diverged at ' + hash);
        }
        // And it still matches the in-memory reference tree, so neither engine drifted.
        const ref = new M.SparseMerkleTree();
        for(const [keyHex, leafHex] of entries) ref.set(M.toBuf(keyHex), M.toBuf(leafHex));
        assert.strictEqual(rootCached, ref.rootHex(), 'cached root diverged from the merkle.js reference');
    });

    it('proving a key this instance just wrote costs ZERO store reads', async function(){
        // This is the _assertCommittedLeaves shape: every ledger-moved key is
        // descended a second time via prove() against the root just committed,
        // over nodes _putBatch wrote moments earlier.
        const store = new ReadCountingStore();
        const smt   = new SC.PersistentSMT(store);
        const root  = await smt.update(SC.EMPTY_ROOT_HEX, keyFor(0), leafFor(0));
        const after = store.getCalls;

        const proof = await smt.prove(root, keyFor(0));
        assert.strictEqual(proof.leaf_value, leafFor(0), 'the proof must still find the leaf');
        assert.strictEqual(store.getCalls - after, 0,
            'the assertion descent must be served entirely from the write-seeded cache; got ' +
            (store.getCalls - after) + ' store reads (the uncached engine paid ' + M.SMT_DEPTH + ')');
    });

    it('the per-block touched-key shape costs materially fewer reads on an established tree', async function(){
        // The shape that matters is NOT buildFull from an empty root (an absent
        // key short-circuits at the first empty subtree, ~log2(keys) levels
        // down). It is computeAndStoreRoots on an ESTABLISHED tree: each touched
        // key is already PRESENT, so its 256 ancestors all have rows and the
        // descent never short-circuits, and _assertCommittedLeaves then descends
        // every one of them a SECOND time via prove() against the final root.
        const entries = [];
        for(let i = 0; i < 60; i++) entries.push([M.toHex(keyFor(i)), leafFor(i)]);

        async function blockPass(store, opts){
            const before = store.getCalls;
            const smt    = new SC.PersistentSMT(store, opts);
            let root = priorRoot;
            for(let i = 0; i < 6; i++) root = await smt.update(root, keyFor(i), leafFor(i + 500));
            for(let i = 0; i < 6; i++){                      // the _assertCommittedLeaves descent
                const proof = await smt.prove(root, keyFor(i));
                assert.strictEqual(proof.leaf_value, leafFor(i + 500), 'the moved leaf must prove under the new root');
            }
            return { root, reads: store.getCalls - before };
        }

        // Seed both stores identically with an uncached engine, so only the
        // block pass itself is measured.
        const cached   = new ReadCountingStore();
        const uncached = new ReadCountingStore();
        const priorRoot = await new SC.PersistentSMT(cached, { nodeCacheMax: 0 }).buildFull(entries);
        assert.strictEqual(await new SC.PersistentSMT(uncached, { nodeCacheMax: 0 }).buildFull(entries), priorRoot);

        const hot  = await blockPass(cached, undefined);
        const cold = await blockPass(uncached, { nodeCacheMax: 0 });

        assert.strictEqual(hot.root, cold.root, 'caching changed the block root: this is a consensus fork');
        assert.ok(cold.reads >= 6 * 2 * M.SMT_DEPTH * 0.9,
            'sanity: the uncached pass must pay ~two full descents per touched key (' + cold.reads + ')');
        // The prove half is served entirely from nodes this pass wrote, so the
        // floor is roughly the update half alone.
        assert.ok(hot.reads < cold.reads * 0.55,
            'the cached pass must cut the block-path reads by more than half; got ' +
            hot.reads + ' against ' + cold.reads + ' uncached');
    });

    it('an ABSENT node is never cached, so the strict-read miss keeps reaching the store', async function(){
        // A cached miss would turn "this subtree is empty" into a decision made
        // once and reused, which is the one thing the M-17 strict-read note in
        // stateCommitment.js says must stay loud.
        const store = new ReadCountingStore();
        const smt   = new SC.PersistentSMT(store);

        await smt.prove(SC.EMPTY_ROOT_HEX, keyFor(5));
        const first = store.getCalls;
        assert.strictEqual(first, 1, 'descending an empty root reads exactly the root and short-circuits');

        await smt.prove(SC.EMPTY_ROOT_HEX, keyFor(6));
        assert.strictEqual(store.getCalls - first, 1,
            'the absent root must be re-read, not answered from a cached miss');
    });

    it('the cache is instance-scoped, so a second engine over the same store starts cold', async function(){
        // Never module-scoped: a rolled-back block transaction must discard every
        // entry with the engine that made them.
        const store = new ReadCountingStore();
        const root  = await new SC.PersistentSMT(store).update(SC.EMPTY_ROOT_HEX, keyFor(9), leafFor(9));

        const fresh = new SC.PersistentSMT(store);
        const at    = store.getCalls;
        const proof = await fresh.prove(root, keyFor(9));
        assert.strictEqual(proof.leaf_value, leafFor(9), 'the fresh engine must still read the committed tree');
        assert.strictEqual(store.getCalls - at, M.SMT_DEPTH,
            'a fresh engine holds no entries from the previous one');
    });

    it('the entry cap bounds the cache without changing the tree', async function(){
        const entries = [];
        for(let i = 0; i < 40; i++) entries.push([M.toHex(keyFor(i)), leafFor(i)]);

        const capped = new ReadCountingStore();
        const smt    = new SC.PersistentSMT(capped, { nodeCacheMax: 64 });
        const root   = await smt.buildFull(entries);

        assert.ok(smt._nodeCache.size <= 64, 'the cache must not exceed its cap (' + smt._nodeCache.size + ')');
        const ref = new M.SparseMerkleTree();
        for(const [keyHex, leafHex] of entries) ref.set(M.toBuf(keyHex), M.toBuf(leafHex));
        assert.strictEqual(root, ref.rootHex(), 'evicting entries must never move the root');
    });
});

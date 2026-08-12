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
 * PersistentSMT node writes are BATCHED, and the batching changes
 * nothing but the statement count.
 *
 * The defect this pins was a throughput one with a correctness-shaped symptom.
 * One key update writes SMT_DEPTH internal nodes, and a value leaf's ancestors
 * are never an all-empty subtree, so the write loop is always a full 256 rows.
 * Issued one statement at a time that is 256 sequential DB round trips per key.
 * On the BTC regtest venue the stakes subtree is rebuilt from an empty root
 * EVERY block over 49 stake keys, which is 12,544 round trips and 25-66s of wall
 * clock per block, against LTC's 3-5s for the same code (LTC commits the empty
 * stakes root, so it never pays it). Five standing envelope tests failed as
 * timeouts and read as correctness failures.
 *
 * Two properties, and the second is the one with teeth:
 *   1. EQUIVALENCE - the batched engine emits the identical root and the
 *      identical node set as a per-node writer. This is the consensus guard.
 *   2. ROUND-TRIP COUNT - a key update costs a BOUNDED number of store writes,
 *      not one per level. Restoring the per-node loop reddens this and only
 *      this, which is what makes it a regression gate rather than a restatement
 *      of the conformance suite. The existing golden/fuzz tests all pass
 *      against the slow engine, which is exactly why they never caught it.
 *
 * No DB required: the counting store implements the same interface as
 * DbNodeStore. The DB-shaped half (chunking, SQL arity) is asserted against a
 * recording fake of doQueryStrict rather than a live MariaDB.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const M  = require('../../src/merkle.js');
const SC = require('../../src/stateCommitment.js');

function keyFor(i){ return M.sha256(Buffer.from('xc1174:' + i, 'utf8')); }
function leafFor(i){ return M.toHex(M.amountLeaf(String(i * 3 + 1) + '.00000000')); }

// A store that answers like MemoryNodeStore but counts how many WRITE calls the
// engine makes, so "one round trip per level" is measurable rather than argued.
class CountingStore {
    constructor(){
        this.map = new Map();
        this.putCalls = 0;         // single-row writes
        this.putManyCalls = 0;     // batch writes
        this.rowsWritten = 0;      // rows offered to the store, batched or not
        this.batchSizes = [];
    }
    async get(h){ return this.map.has(h) ? this.map.get(h) : null; }
    _set(h, l, r){
        this.rowsWritten++;
        if(!this.map.has(h)) this.map.set(h, { left_hash: l, right_hash: r });
    }
    async put(h, l, r){ this.putCalls++; this._set(h, l, r); }
    async putMany(nodes){
        this.putManyCalls++;
        this.batchSizes.push(nodes.length);
        for(const n of nodes) this._set(n.hash, n.left, n.right);
    }
    get writeCalls(){ return this.putCalls + this.putManyCalls; }
}

// A store that predates putMany: bare {get, put}, like the subtree unit fakes
// and the bin/ instrumentation decorator. Doubles as the pre-fix reference the
// batched engine must match row for row.
class PerNodeStore extends CountingStore {
    constructor(){ super(); this.putMany = undefined; }
}

describe('stateCommitment: batched SMT node writes @regression', function(){

    it('a key update costs ONE store write call, not one per tree level', async function(){
        const store = new CountingStore();
        const smt   = new SC.PersistentSMT(store);
        const root  = await smt.update(SC.EMPTY_ROOT_HEX, keyFor(0), leafFor(0));

        assert.notStrictEqual(root, SC.EMPTY_ROOT_HEX, 'the update must actually have written a tree');
        // The rows are unchanged: a leaf's ancestors are never empty, so the full
        // depth is still persisted. Only the number of calls carrying them changes.
        assert.strictEqual(store.rowsWritten, M.SMT_DEPTH,
            'a single key still persists one internal node per level');
        assert.strictEqual(store.writeCalls, 1,
            'one key update must cost ONE store write call; got ' + store.writeCalls +
            ' (the pre-batch engine cost ' + M.SMT_DEPTH + ', which is 25-66s per block on the BTC regtest venue)');
        assert.strictEqual(store.putCalls, 0, 'the batched path must not fall back to single-row writes');
    });

    it('the BTC stakes-subtree shape stays bounded: 49 keys cost 49 write calls, not 12,544', async function(){
        // 49 keys is the measured live figure: getstakeweightsbycapability reports
        // keys=49 on the BTC regtest venue, and buildFull re-runs over all of them
        // on EVERY block.
        const entries = [];
        for(let i = 0; i < 49; i++) entries.push([M.toHex(keyFor(i)), leafFor(i)]);

        const store = new CountingStore();
        const smt   = new SC.PersistentSMT(store);
        await smt.buildFull(entries);

        assert.strictEqual(store.writeCalls, 49,
            'buildFull must cost one write call per key; got ' + store.writeCalls);
        assert.ok(store.rowsWritten >= 49 * 100,
            'sanity: the batches must still carry the full node payload (' + store.rowsWritten + ' rows)');
    });

    it('batched writes emit the SAME root and the SAME node set as per-node writes', async function(){
        const entries = [];
        for(let i = 0; i < 60; i++) entries.push([M.toHex(keyFor(i)), leafFor(i)]);

        const batched = new CountingStore();
        const perNode = new PerNodeStore();
        const rootBatched = await new SC.PersistentSMT(batched).buildFull(entries);
        const rootPerNode = await new SC.PersistentSMT(perNode).buildFull(entries);

        assert.strictEqual(rootBatched, rootPerNode, 'batching changed the root: this is a consensus fork');
        assert.strictEqual(batched.map.size, perNode.map.size, 'batching changed the persisted node count');
        for(const [hash, row] of perNode.map){
            const got = batched.map.get(hash);
            assert.ok(got, 'batched store is missing node ' + hash);
            assert.strictEqual(got.left_hash,  row.left_hash,  'left child diverged at ' + hash);
            assert.strictEqual(got.right_hash, row.right_hash, 'right child diverged at ' + hash);
        }
        // And it still matches the in-memory reference tree, so neither writer drifted.
        const ref = new M.SparseMerkleTree();
        for(const [keyHex, leafHex] of entries) ref.set(M.toBuf(keyHex), M.toBuf(leafHex));
        assert.strictEqual(rootBatched, ref.rootHex(), 'batched root diverged from the merkle.js reference');
    });

    it('the batch is flushed before update() returns, so the next descend sees it', async function(){
        // buildFull threads the returned root into the next update()'s _descend,
        // which READS the store. Deferring the flush past the return would make
        // shared-prefix keys descend a tree missing its own nodes and silently
        // emit a truncated root.
        const store = new CountingStore();
        const smt   = new SC.PersistentSMT(store);
        const root1 = await smt.update(SC.EMPTY_ROOT_HEX, keyFor(1), leafFor(1));
        assert.ok(store.map.has(root1), 'the new root node must be durable the moment update() returns');

        const root2 = await smt.update(root1, keyFor(2), leafFor(2));
        const proof = await smt.prove(root2, keyFor(1));
        assert.strictEqual(proof.leaf_value, leafFor(1),
            'the first key must still prove under the second root, which requires the first flush to have landed');
    });

    it('a store with no putMany still gets the identical rows, one call per level', async function(){
        // The fallback is a SLOWNESS, never a wrongness. A bare {get, put} store
        // must land the same tree; only its round-trip count differs.
        const legacy = new PerNodeStore();
        const smt    = new SC.PersistentSMT(legacy);
        const root   = await smt.update(SC.EMPTY_ROOT_HEX, keyFor(3), leafFor(3));

        assert.strictEqual(legacy.putCalls, M.SMT_DEPTH, 'the fallback writes one node per level');
        assert.strictEqual(legacy.rowsWritten, M.SMT_DEPTH, 'and drops none of them');

        const batched = new CountingStore();
        const rootBatched = await new SC.PersistentSMT(batched).update(SC.EMPTY_ROOT_HEX, keyFor(3), leafFor(3));
        assert.strictEqual(root, rootBatched, 'the fallback and the batch must agree on the root');
        assert.deepStrictEqual([...legacy.map.keys()].sort(), [...batched.map.keys()].sort(),
            'the fallback and the batch must persist the identical node set');
    });

    it('DbNodeStore itself exposes putMany, so the real block path never takes the fallback', async function(){
        // The fallback exists for decorators and fakes. If it ever became the
        // path the indexer actually runs, block parse would silently return to
        // 25-66s with every conformance test still green - which is precisely
        // how survived. This is the gate on that.
        assert.strictEqual(typeof SC.DbNodeStore.prototype.putMany, 'function',
            'DbNodeStore must implement the batch write; without it the block path is 256 round trips per key');
        assert.strictEqual(typeof SC.MemoryNodeStore.prototype.putMany, 'function',
            'MemoryNodeStore must match the DbNodeStore interface');
    });

    it('deletes batch the same way and still return the tree to the empty root', async function(){
        const store = new CountingStore();
        const smt   = new SC.PersistentSMT(store);
        let root = SC.EMPTY_ROOT_HEX;
        for(let i = 0; i < 8; i++) root = await smt.update(root, keyFor(i), leafFor(i));
        const afterInsert = store.writeCalls;
        for(let i = 0; i < 8; i++) root = await smt.update(root, keyFor(i), null);

        assert.strictEqual(root, SC.EMPTY_ROOT_HEX, 'deleting every key must return the empty root');
        // A delete collapses its path into EMPTY constants, which are never stored,
        // so it writes at most one batch and often none at all.
        assert.ok(store.writeCalls - afterInsert <= 8,
            'deletes must not reintroduce a per-level write call (' + (store.writeCalls - afterInsert) + ')');
    });
});

describe('stateCommitment: stakes subtree rebuilds only on change @regression', function(){

    const CHAIN = 'BTC', NETWORK = 'regtest';
    // 49 keys is the live figure the BTC regtest venue reports
    // (getstakeweightsbycapability keys=49), rebuilt from an empty root every block.
    function stakeEntries(n, salt){
        const out = [];
        for(let i = 0; i < n; i++)
            out.push([M.toHex(keyFor('stake:' + i)), leafFor(i + (salt || 0))]);
        return out;
    }

    beforeEach(function(){ SC.resetStakesMemo(); });
    afterEach(function(){ SC.resetStakesMemo(); });

    function freshSmt(){ return new SC.PersistentSMT(new CountingStore()); }

    it('an unchanged stake set on the next block writes NOTHING and returns the same root', async function(){
        const smt = freshSmt();
        const e = stakeEntries(49);
        const first = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, e);
        const afterFirst = smt.store.writeCalls;
        assert.strictEqual(afterFirst, 49, 'the first block builds the whole tree');

        const second = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 101, stakeEntries(49));
        assert.strictEqual(second, first, 'an unchanged stake set must commit the same stakes_root');
        assert.strictEqual(smt.store.writeCalls, afterFirst,
            'an unchanged stake set must write no nodes at all; wrote ' + (smt.store.writeCalls - afterFirst));
    });

    it('a RUN of unchanged blocks writes nothing after the first, not every other one', async function(){
        // A memo that answers a hit but does not re-stamp itself still passes the
        // single-hit test: block 101 hits, then block 102 is no longer the memo's
        // successor and rebuilds. That halves the defect instead of fixing it, and
        // it is invisible unless the run is longer than two blocks. The regtest
        // suite runs hundreds.
        const smt = freshSmt();
        let root = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, stakeEntries(49));
        const afterFirst = smt.store.writeCalls;
        for(let h = 101; h <= 110; h++){
            const next = await SC.buildStakesRoot(smt, CHAIN, NETWORK, h, stakeEntries(49));
            assert.strictEqual(next, root, 'the root moved on an unchanged stake set at height ' + h);
            root = next;
        }
        assert.strictEqual(smt.store.writeCalls, afterFirst,
            'ten unchanged blocks must write nothing; wrote ' + (smt.store.writeCalls - afterFirst) +
            ' batches (a memo that does not re-stamp itself rebuilds every other block)');
    });

    it('a CHANGED stake set rebuilds and moves the root', async function(){
        const smt = freshSmt();
        const first  = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, stakeEntries(49));
        const before = smt.store.writeCalls;
        const second = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 101, stakeEntries(49, 1));
        assert.notStrictEqual(second, first, 'a changed stake set must move the root');
        assert.ok(smt.store.writeCalls > before, 'a changed stake set must actually rebuild');
    });

    it('the memoized root is byte-identical to what buildFull would have returned', async function(){
        // The whole safety case: the shortcut may not be a different answer.
        const e = stakeEntries(49);
        const memoSmt = freshSmt();
        await SC.buildStakesRoot(memoSmt, CHAIN, NETWORK, 100, e);
        const memoized = await SC.buildStakesRoot(memoSmt, CHAIN, NETWORK, 101, stakeEntries(49));

        const plain = await freshSmt().buildFull(stakeEntries(49));
        assert.strictEqual(memoized, plain, 'the memo returned a root buildFull would not have produced');
    });

    it('a GAP in block continuity rebuilds, even with an identical stake set', async function(){
        // A reorg or a rollback lands on a block that is not the memo's successor.
        const smt = freshSmt();
        await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, stakeEntries(49));
        const before = smt.store.writeCalls;
        await SC.buildStakesRoot(smt, CHAIN, NETWORK, 105, stakeEntries(49));
        assert.ok(smt.store.writeCalls > before,
            'a non-successor block must rebuild rather than trust the memo');
    });

    it('re-parsing the SAME block index rebuilds rather than trusting a sibling memo', async function(){
        const smt = freshSmt();
        await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, stakeEntries(49));
        const before = smt.store.writeCalls;
        await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, stakeEntries(49));
        assert.ok(smt.store.writeCalls > before, 'block N is not the successor of block N');
    });

    it('a different chain or network never reads the other one\'s memo', async function(){
        const smt = freshSmt();
        await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, stakeEntries(49));
        let before = smt.store.writeCalls;
        await SC.buildStakesRoot(smt, 'LTC', NETWORK, 101, stakeEntries(49));
        assert.ok(smt.store.writeCalls > before, 'a different chain must rebuild');

        SC.resetStakesMemo();
        await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, stakeEntries(49));
        before = smt.store.writeCalls;
        await SC.buildStakesRoot(smt, CHAIN, 'mainnet', 101, stakeEntries(49));
        assert.ok(smt.store.writeCalls > before, 'a different network must rebuild');
    });

    it('a cold start has no memo, so the first block after a restart rebuilds', async function(){
        const smt = freshSmt();
        await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, stakeEntries(49));
        SC.resetStakesMemo();                       // models the process restarting
        const before = smt.store.writeCalls;
        await SC.buildStakesRoot(smt, CHAIN, NETWORK, 101, stakeEntries(49));
        assert.ok(smt.store.writeCalls > before, 'a cold start must rebuild, not trust a stale root');
    });

    it('a memoized root missing from the store rebuilds instead of committing it', async function(){
        // Models the node store being wiped or pruned under a live process. The
        // memo would otherwise commit a root whose tree is not there to prove.
        const smt = freshSmt();
        const first = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, stakeEntries(49));
        smt.store.map.clear();
        const before = smt.store.writeCalls;
        const second = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 101, stakeEntries(49));
        assert.ok(smt.store.writeCalls > before, 'a vanished tree must be rebuilt');
        assert.strictEqual(second, first, 'and the rebuild must land on the same root');
        assert.ok(smt.store.map.has(first), 'the tree must be back in the store');
    });

    it('reordering the same stake entries still hits, because buildFull is order-independent', async function(){
        const smt = freshSmt();
        const e = stakeEntries(49);
        const first = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, e);
        const before = smt.store.writeCalls;
        const second = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 101, e.slice().reverse());
        assert.strictEqual(second, first, 'a reorder is not a change');
        assert.strictEqual(smt.store.writeCalls, before, 'and must not trigger a rebuild');
    });

    it('an empty stake set is memoized without a store read that cannot succeed', async function(){
        // The empty root is never a row in state_tree_nodes, so an existence check
        // on it would always miss and rebuild forever.
        const smt = freshSmt();
        const first = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, []);
        assert.strictEqual(first, SC.EMPTY_ROOT_HEX);
        const before = smt.store.writeCalls;
        const second = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 101, []);
        assert.strictEqual(second, SC.EMPTY_ROOT_HEX);
        assert.strictEqual(smt.store.writeCalls, before, 'an empty set must not rebuild every block');
    });
});

describe('stateCommitment: DbNodeStore.putMany SQL shape @regression', function(){

    // Records what would go to MariaDB without needing one.
    function fakeDb(){
        const calls = [];
        return {
            calls,
            async doQueryStrict(sql, args){ calls.push({ sql, args }); return []; }
        };
    }

    it('writes one multi-row INSERT IGNORE with three bound params per row', async function(){
        const db = fakeDb();
        const store = new SC.DbNodeStore(db);
        const nodes = [];
        for(let i = 0; i < 10; i++)
            nodes.push({ hash: 'h' + i, left: 'l' + i, right: 'r' + i });
        await store.putMany(nodes);

        assert.strictEqual(db.calls.length, 1, 'ten nodes must be one statement, not ten');
        const { sql, args } = db.calls[0];
        assert.ok(/^INSERT IGNORE INTO state_tree_nodes \(node_hash, left_hash, right_hash\) VALUES /.test(sql),
            'statement must stay an INSERT IGNORE on state_tree_nodes: ' + sql);
        assert.strictEqual((sql.match(/\(\?, \?, \?\)/g) || []).length, 10, 'one value tuple per node');
        assert.strictEqual(args.length, 30, 'three bound params per node');
        assert.deepStrictEqual(args.slice(0, 6), ['h0', 'l0', 'r0', 'h1', 'l1', 'r1'],
            'params must be flattened in hash/left/right order');
    });

    it('chunks a full-depth path so no single statement grows unbounded', async function(){
        const db = fakeDb();
        const store = new SC.DbNodeStore(db);
        const nodes = [];
        for(let i = 0; i < M.SMT_DEPTH; i++)
            nodes.push({ hash: 'h' + i, left: 'l' + i, right: 'r' + i });
        await store.putMany(nodes);

        assert.ok(db.calls.length >= 2 && db.calls.length <= 4,
            '256 nodes should chunk into a small handful of statements, got ' + db.calls.length);
        let rows = 0;
        for(const c of db.calls){
            const tuples = (c.sql.match(/\(\?, \?, \?\)/g) || []).length;
            assert.ok(tuples <= 128, 'a chunk exceeded the declared 128-row bound: ' + tuples);
            assert.strictEqual(c.args.length, tuples * 3, 'chunk arity must match its tuple count');
            rows += tuples;
        }
        assert.strictEqual(rows, M.SMT_DEPTH, 'chunking must not drop or duplicate a node');
    });

    it('an empty batch issues no statement at all', async function(){
        const db = fakeDb();
        await new SC.DbNodeStore(db).putMany([]);
        assert.strictEqual(db.calls.length, 0, 'an empty batch must not send an INSERT with no VALUES');
    });

    it('duplicate hashes inside one batch are left to INSERT IGNORE, not pre-filtered away', async function(){
        // INSERT IGNORE already makes a repeated key a no-op WITHIN a single
        // multi-row statement, exactly as it did across the old single-row calls.
        // Asserted so nobody "fixes" it later with a dedup pass that would have to
        // be kept correct for no gain.
        const db = fakeDb();
        const store = new SC.DbNodeStore(db);
        await store.putMany([
            { hash: 'dup', left: 'a', right: 'b' },
            { hash: 'dup', left: 'a', right: 'b' }
        ]);
        assert.strictEqual(db.calls.length, 1);
        assert.strictEqual(db.calls[0].args.length, 6, 'both rows must reach the statement');
    });
});

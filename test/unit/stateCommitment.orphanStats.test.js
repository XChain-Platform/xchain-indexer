/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/stateCommitment.orphanStats.test.js
 *
 * Read-only orphan-count observability for the COW state_tree_nodes store
 * (SPV spec 4.3). reportOrphanStats marks reachability from the UNION of every
 * RETAINED state_tree_roots row (because the explorer serves SPV proofs against
 * historical roots) and reports total/reachable/orphan WITHOUT deleting. These
 * tests build real SMT trees, then drop a root from the "retained" set to create
 * genuine reorg-orphan nodes, and assert the counts.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const M      = require('../../src/merkle.js');
const SC     = require('../../src/stateCommitment.js');

// Drive a query(sql,args) over an in-memory node store + an explicit live-root list,
// matching the three statements reportOrphanStats issues. The node read is the
// batched frontier lookup (WHERE node_hash IN (?,...)), so the fake answers it the
// way uq_node_hash does: only the requested hashes, only the ones that have a row.
// `log` (optional) collects every statement so a test can assert the SHAPE of the
// reads, which is the whole point of the walk.
function makeQuery(store, liveRoots, log) {
    return async (sql, args) => {
        if (log) log.push({ sql, args });
        if (/COUNT\(\*\)/.test(sql)) return [{ c: store.map.size }];
        if (/SELECT node_hash, left_hash, right_hash/.test(sql)) {
            assert.ok(/WHERE node_hash IN \(\?(,\?)*\)$/.test(sql),
                'the node read must be a bounded indexed IN-batch, never a full-table scan: ' + sql);
            assert.strictEqual(sql.split('?').length - 1, args.length, 'one placeholder per requested hash');
            return args.filter(h => store.map.has(h)).map(h => {
                const v = store.map.get(h);
                return { node_hash: h, left_hash: v.left_hash, right_hash: v.right_hash };
            });
        }
        if (/FROM state_tree_roots/.test(sql)) return liveRoots.map(r => ({ r }));
        return [];
    };
}

// A distinct value-leaf hex (any valid 32-byte hash works; content just needs to differ).
function leaf(n) { return M.toHex(M.leafHash(M.canonicalAmount(String(n)))); }
function key(hexByte) { return M.toBuf(hexByte.repeat(64)); }

describe('stateCommitment.reportOrphanStats @regression @tier2', function () {

    it('reports zero orphans when every node is reachable from the single retained root', async function () {
        const store = new SC.MemoryNodeStore();
        const smt   = new SC.PersistentSMT(store);
        const rootA = await smt.update(SC.EMPTY_ROOT_HEX, key('1'), leaf(5));

        const stats = await SC.reportOrphanStats(makeQuery(store, [rootA, SC.EMPTY_ROOT_HEX]), 'BTC', 'regtest');
        assert.strictEqual(stats.totalNodes, store.map.size);
        assert.strictEqual(stats.reachableNodes, store.map.size);
        assert.strictEqual(stats.orphanCount, 0);
        assert.strictEqual(stats.reachabilitySkipped, false);
    });

    it('counts nodes reachable ONLY from a dropped (reorged) root as orphans', async function () {
        const store = new SC.MemoryNodeStore();
        const smt   = new SC.PersistentSMT(store);
        const rootA = await smt.update(SC.EMPTY_ROOT_HEX, key('a'), leaf(5));   // later reorged away
        const sizeA = store.map.size;
        const rootB = await smt.update(SC.EMPTY_ROOT_HEX, key('b'), leaf(9));   // surviving chain
        const sizeB = store.map.size - sizeA;
        assert.notStrictEqual(rootA, rootB);

        // Only rootB is retained in state_tree_roots; rootA's nodes are orphans.
        const stats = await SC.reportOrphanStats(makeQuery(store, [rootB, SC.EMPTY_ROOT_HEX]), 'BTC', 'regtest');
        assert.strictEqual(stats.totalNodes, sizeA + sizeB);
        assert.strictEqual(stats.reachableNodes, sizeB, 'only the surviving-root subtree is reachable');
        assert.strictEqual(stats.orphanCount, sizeA, 'the dropped-root subtree counts as orphaned');
    });

    it('keeps historical-root nodes live (proof safety): retaining BOTH roots yields zero orphans', async function () {
        const store = new SC.MemoryNodeStore();
        const smt   = new SC.PersistentSMT(store);
        const rootA = await smt.update(SC.EMPTY_ROOT_HEX, key('a'), leaf(5));
        const rootB = await smt.update(SC.EMPTY_ROOT_HEX, key('b'), leaf(9));

        // Both roots retained (the real sweep marks from ALL retained state_tree_roots rows).
        const stats = await SC.reportOrphanStats(makeQuery(store, [rootA, rootB]), 'BTC', 'regtest');
        assert.strictEqual(stats.orphanCount, 0, 'a node reachable from any retained historical root is live');
        assert.strictEqual(stats.reachableNodes, store.map.size);
    });

    it('returns all-zero for an empty store', async function () {
        const store = new SC.MemoryNodeStore();
        const stats = await SC.reportOrphanStats(makeQuery(store, []), 'BTC', 'regtest');
        assert.deepStrictEqual(stats, { totalNodes: 0, reachableNodes: 0, orphanCount: 0, reachabilitySkipped: false });
    });

    it('stops the walk at maxNodes and flags the truncated figure as an estimate', async function () {
        const store = new SC.MemoryNodeStore();
        const smt   = new SC.PersistentSMT(store);
        const rootA = await smt.update(SC.EMPTY_ROOT_HEX, key('a'), leaf(5));

        const stats = await SC.reportOrphanStats(makeQuery(store, [rootA, SC.EMPTY_ROOT_HEX]), 'BTC', 'regtest',
            { maxNodes: 1, batchSize: 1 });
        assert.ok(stats.totalNodes > 1);
        // The estimate no longer goes silent (regression 2665) AND no longer loads a
        // maxNodes-row sample to produce it: the walk simply stops at the cap, which
        // makes reachableNodes a lower bound and orphanCount the upper bound it implies.
        assert.strictEqual(stats.reachabilitySkipped, false, 'no longer goes silent above the ceiling');
        assert.strictEqual(stats.reachabilityEstimated, true, 'flags a truncated walk as an estimate');
        assert.ok(stats.reachableNodes >= 1 && stats.reachableNodes < stats.totalNodes,
            'a truncated walk reports a partial reachable count');
        assert.strictEqual(stats.orphanCount, stats.totalNodes - stats.reachableNodes,
            'orphan stays total - reachable, i.e. the upper bound implied by the lower-bound mark');
    });

    it('never materializes the node table: reads only reachable rows, in bounded batches', async function () {
        const store = new SC.MemoryNodeStore();
        const smt   = new SC.PersistentSMT(store);
        const rootA = await smt.update(SC.EMPTY_ROOT_HEX, key('a'), leaf(5));   // reorged away
        const rootB = await smt.update(SC.EMPTY_ROOT_HEX, key('b'), leaf(9));   // retained
        const log   = [];

        // batchSize 1 forces one round trip per frontier hash, so the counts below are exact.
        const stats = await SC.reportOrphanStats(makeQuery(store, [rootB], log), 'BTC', 'regtest', { batchSize: 1 });
        const nodeReads = log.filter(e => /SELECT node_hash, left_hash, right_hash/.test(e.sql));

        // The fake asserts the IN-batch shape on every node read; here we pin the volume:
        // only reachable hashes are ever requested, so the orphaned rootA subtree is
        // never read at all, and no single statement asks for more than batchSize hashes.
        assert.ok(nodeReads.length > 1, 'the walk issues one indexed lookup per frontier batch');
        assert.ok(nodeReads.every(e => e.args.length <= 1), 'no batch exceeds batchSize');
        assert.ok(nodeReads.length < store.map.size,
            'fewer node reads than rows in the store: the orphaned subtree is never touched');
        // A depth-255 node's value-leaf child is non-EMPTY but has no row of its own, so
        // the walk queues it, finds nothing and never counts it: reads exceed the reachable
        // count by exactly the reachable leaves, and are still bounded by 2x + 1.
        assert.ok(stats.reachableNodes <= nodeReads.length && nodeReads.length <= stats.reachableNodes * 2 + 1,
            'only a row-bearing hash is counted reachable, and the queued fringe stays bounded');
        assert.strictEqual(stats.orphanCount, store.map.size - stats.reachableNodes);
        assert.strictEqual(stats.reachabilityEstimated, undefined, 'a complete walk is not an estimate');
    });

    it('batching does not change the answer: batchSize 1 and the default agree', async function () {
        const store = new SC.MemoryNodeStore();
        const smt   = new SC.PersistentSMT(store);
        await smt.update(SC.EMPTY_ROOT_HEX, key('a'), leaf(5));
        const rootB = await smt.update(SC.EMPTY_ROOT_HEX, key('b'), leaf(9));

        const one  = await SC.reportOrphanStats(makeQuery(store, [rootB]), 'BTC', 'regtest', { batchSize: 1 });
        const many = await SC.reportOrphanStats(makeQuery(store, [rootB]), 'BTC', 'regtest', { batchSize: 4096 });
        assert.deepStrictEqual(one, many, 'the frontier walk is batch-size independent');
    });
});

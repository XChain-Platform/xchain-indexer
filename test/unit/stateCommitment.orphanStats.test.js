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
// matching the three statements reportOrphanStats issues.
function makeQuery(store, liveRoots) {
    return async (sql, args) => {
        if (/COUNT\(\*\)/.test(sql)) return [{ c: store.map.size }];
        if (/SELECT node_hash, left_hash, right_hash/.test(sql)) {
            let entries = Array.from(store.map.entries()).map(([h, v]) => ({
                node_hash: h, left_hash: v.left_hash, right_hash: v.right_hash
            }));
            // Mirror the sampled path's deterministic ORDER BY node_hash LIMIT ?.
            if (/ORDER BY node_hash/.test(sql)) entries.sort((a, b) => (a.node_hash < b.node_hash ? -1 : a.node_hash > b.node_hash ? 1 : 0));
            if (/LIMIT/.test(sql) && args && args.length) entries = entries.slice(0, Number(args[args.length - 1]));
            return entries;
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

    it('emits a bounded sampled reachability estimate (not silence) when the store exceeds maxNodes', async function () {
        const store = new SC.MemoryNodeStore();
        const smt   = new SC.PersistentSMT(store);
        const rootA = await smt.update(SC.EMPTY_ROOT_HEX, key('a'), leaf(5));

        const stats = await SC.reportOrphanStats(makeQuery(store, [rootA, SC.EMPTY_ROOT_HEX]), 'BTC', 'regtest', { maxNodes: 1 });
        assert.ok(stats.totalNodes > 1);
        // The estimate no longer goes silent (regression 2665): above the ceiling it
        // returns a bounded, sample-scoped figure flagged as an estimate rather than null.
        assert.strictEqual(stats.reachabilitySkipped, false, 'no longer goes silent above the ceiling');
        assert.strictEqual(stats.reachabilityEstimated, true, 'flags the figure as a sample-scoped estimate');
        assert.strictEqual(stats.sampledNodes, 1, 'sample is bounded to maxNodes rows');
        assert.strictEqual(typeof stats.reachableNodes, 'number');
        assert.strictEqual(stats.orphanCount, stats.sampledNodes - stats.reachableNodes, 'orphan = sampled - reachable within the sample');
    });
});

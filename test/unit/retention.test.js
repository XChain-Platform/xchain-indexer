//********************************************************************
//
// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
//********************************************************************
//
// State-retention scaffold . Covers config gating (default off), the
// phase-1 root-prune window, phase-2 orphan reachability + reclaim, dry-run,
// runExclusive serialization, and the fork-safety invariant (a node reachable
// from a surviving root is never deleted even when it was also under a pruned
// root). No DB required: an in-memory query double answers the exact SQL the
// module issues.

'use strict';

const assert = require('assert');
const M = require('../../src/merkle.js');
const R = require('../../src/retention.js');

const EMPTY = M.toHex(M.EMPTY[256]);   // an EMPTY subtree constant (skipped by the mark)
const A = 'a'.repeat(64);   // new tip root's balances_root
const B = 'b'.repeat(64);   // shared child: under BOTH the new and the old root
const C = 'c'.repeat(64);   // old (prunable) root's balances_root
const D = 'd'.repeat(64);   // child reachable ONLY from the old root

// In-memory double answering only the queries retention.js issues. Mutates rows
// on DELETE so a phase-1 prune is visible to the phase-2 mark that follows.
function makeDb(){
    const db = {
        chain: 'BTC',
        network: 'regtest',
        roots: [
            { block_index: 100, balances_root: A, stakes_root: EMPTY },
            { block_index: 10,  balances_root: C, stakes_root: EMPTY }
        ],
        nodes: [
            { node_hash: A, left_hash: B,     right_hash: EMPTY },
            { node_hash: B, left_hash: EMPTY, right_hash: EMPTY },
            { node_hash: C, left_hash: D,     right_hash: B     },
            { node_hash: D, left_hash: EMPTY, right_hash: EMPTY }
        ],
        calls: []
    };
    db.query = async (sql, args) => {
        db.calls.push(sql);
        if(sql.includes('MAX(block_index)')){
            const vals = db.roots.map(r => r.block_index);
            return [{ tip: vals.length ? Math.max.apply(null, vals) : null }];
        }
        if(sql.includes('COUNT(*)') && sql.includes('state_tree_roots')){
            const cutoff = args[2];
            return [{ c: db.roots.filter(r => r.block_index <= cutoff).length }];
        }
        if(sql.startsWith('DELETE FROM state_tree_roots')){
            const cutoff = args[2];
            const before = db.roots.length;
            db.roots = db.roots.filter(r => r.block_index > cutoff);
            return { affectedRows: before - db.roots.length };
        }
        if(sql.startsWith('SELECT node_hash')){
            return db.nodes.map(n => ({ node_hash: n.node_hash, left_hash: n.left_hash, right_hash: n.right_hash }));
        }
        if(sql.includes('UNION')){
            const set = new Set();
            for(const r of db.roots){ set.add(r.balances_root); set.add(r.stakes_root); }
            return Array.from(set).map(r => ({ r }));
        }
        if(sql.startsWith('DELETE FROM state_tree_nodes')){
            const before = db.nodes.length;
            const kill = new Set(args);
            db.nodes = db.nodes.filter(n => !kill.has(n.node_hash));
            return { affectedRows: before - db.nodes.length };
        }
        throw new Error('unexpected query: ' + sql);
    };
    return db;
}

describe('retention: config gating (default off)', () => {
    it('is disabled with no env set', () => {
        const cfg = R.parseRetentionConfig({});
        assert.strictEqual(cfg.enabled, false);
        assert.strictEqual(cfg.rootKeepBlocks, null);
        assert.strictEqual(cfg.nodeReclaimEnabled, false);
    });

    it('stays off for zero or non-numeric window', () => {
        assert.strictEqual(R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '0' }).enabled, false);
        assert.strictEqual(R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: 'nope' }).enabled, false);
        assert.strictEqual(R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '-5' }).enabled, false);
    });

    it('enables phase 1 with a positive window; phase 2 only with explicit opt-in', () => {
        const cfg = R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '50' });
        assert.strictEqual(cfg.enabled, true);
        assert.strictEqual(cfg.rootKeepBlocks, 50);
        assert.strictEqual(cfg.nodeReclaimEnabled, false);

        const cfg2 = R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '50', STATE_NODE_RECLAIM: 'true' });
        assert.strictEqual(cfg2.nodeReclaimEnabled, true);
        const cfg3 = R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '50', STATE_NODE_RECLAIM: '1' });
        assert.strictEqual(cfg3.nodeReclaimEnabled, true);
    });

    it('ignores STATE_NODE_RECLAIM when retention itself is off', () => {
        const cfg = R.parseRetentionConfig({ STATE_NODE_RECLAIM: 'true' });
        assert.strictEqual(cfg.enabled, false);
        assert.strictEqual(cfg.nodeReclaimEnabled, false);
    });
});

describe('retention: phase-1 root prune', () => {
    it('planner reports the prunable window without deleting', async () => {
        const db = makeDb();
        const plan = await R.planStateRootPrune(db.query, 'BTC', 'regtest', 50);
        assert.strictEqual(plan.tip, 100);
        assert.strictEqual(plan.cutoff, 50);       // keep > tip-50 = keep >50, prune <=50
        assert.strictEqual(plan.prunableCount, 1); // block 10
        assert.strictEqual(db.roots.length, 2);    // planner deleted nothing
    });

    it('planner is a no-op on an empty table', async () => {
        const db = makeDb();
        db.roots = [];
        const plan = await R.planStateRootPrune(db.query, 'BTC', 'regtest', 50);
        assert.strictEqual(plan.tip, null);
        assert.strictEqual(plan.prunableCount, 0);
    });

    it('planner prunes nothing when the window covers the whole chain', async () => {
        const db = makeDb();
        const plan = await R.planStateRootPrune(db.query, 'BTC', 'regtest', 500);
        assert.strictEqual(plan.cutoff, null);     // tip-500 < 0
        assert.strictEqual(plan.prunableCount, 0);
    });

    it('executor drops roots older than the window, keeps the tip', async () => {
        const db = makeDb();
        const cfg = R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '50' });
        const res = await R.pruneStateRoots(db.query, 'BTC', 'regtest', cfg);
        assert.strictEqual(res.deleted, 1);
        assert.deepStrictEqual(db.roots.map(r => r.block_index), [100]);
    });

    it('executor is inert when the policy is off', async () => {
        const db = makeDb();
        const cfg = R.parseRetentionConfig({});
        const res = await R.pruneStateRoots(db.query, 'BTC', 'regtest', cfg);
        assert.strictEqual(res.skipped, true);
        assert.strictEqual(res.deleted, 0);
        assert.strictEqual(db.roots.length, 2);
    });
});

describe('retention: phase-2 orphan reachability + reclaim', () => {
    it('computeReachable marks the union of all current roots', async () => {
        const db = makeDb();  // both roots present: A,B (from A) and C,D,B (from C)
        const { nodes, reachable } = await R.computeReachable(db.query, 'BTC', 'regtest');
        assert.strictEqual(nodes.size, 4);
        assert.strictEqual(reachable.size, 4);   // A,B,C,D all reachable
    });

    it('dryRun reports orphans without deleting', async () => {
        const db = makeDb();
        // Simulate post phase-1: only the tip root (A) survives.
        db.roots = db.roots.filter(r => r.block_index === 100);
        const cfg = R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '50', STATE_NODE_RECLAIM: '1' });
        const res = await R.reclaimOrphanNodes(db.query, 'BTC', 'regtest', cfg, { dryRun: true });
        assert.strictEqual(res.dryRun, true);
        assert.strictEqual(res.deleted, 0);
        assert.strictEqual(res.orphanCount, 2);              // C and D
        assert.deepStrictEqual(res.orphans.sort(), [C, D].sort());
        assert.strictEqual(db.nodes.length, 4);              // nothing deleted
    });

    it('reclaim deletes orphans and NEVER a node reachable from a surviving root', async () => {
        const db = makeDb();
        db.roots = db.roots.filter(r => r.block_index === 100);  // only tip A survives
        const cfg = R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '50', STATE_NODE_RECLAIM: '1' });
        const res = await R.reclaimOrphanNodes(db.query, 'BTC', 'regtest', cfg);
        assert.strictEqual(res.deleted, 2);
        const survivors = db.nodes.map(n => n.node_hash).sort();
        assert.deepStrictEqual(survivors, [A, B].sort());
        // Fork-safety: B was ALSO under the pruned root C, yet it survives because
        // the retained root A still reaches it. Deleting it would fork balances_root.
        assert.ok(survivors.includes(B));
    });

    it('is inert when node reclaim is not opted in', async () => {
        const db = makeDb();
        const cfg = R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '50' });  // phase 1 only
        const res = await R.reclaimOrphanNodes(db.query, 'BTC', 'regtest', cfg);
        assert.strictEqual(res.skipped, true);
        assert.strictEqual(db.nodes.length, 4);
    });

    it('skips the mark above the node-count cap (bounded memory)', async () => {
        const db = makeDb();
        const cfg = R.parseRetentionConfig({
            STATE_ROOT_RETENTION_BLOCKS: '50', STATE_NODE_RECLAIM: '1', STATE_TREE_METRIC_MAX_NODES: '3'
        });
        const res = await R.reclaimOrphanNodes(db.query, 'BTC', 'regtest', cfg);
        assert.strictEqual(res.skipped, true);
        assert.strictEqual(res.reason, 'too_many_nodes');
        assert.strictEqual(db.nodes.length, 4);   // nothing deleted
    });
});

describe('retention: runExclusive serialization', () => {
    it('runs the phase-2 mark+delete inside the supplied exclusive wrapper', async () => {
        const db = makeDb();
        db.roots = db.roots.filter(r => r.block_index === 100);
        const cfg = R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '50', STATE_NODE_RECLAIM: '1' });
        let heldDuringWork = false;
        let held = false;
        const runExclusive = async (fn) => {
            held = true;
            try {
                const out = await fn();
                heldDuringWork = held;   // still inside the critical section when work ran
                return out;
            } finally { held = false; }
        };
        const res = await R.reclaimOrphanNodes(db.query, 'BTC', 'regtest', cfg, { runExclusive });
        assert.strictEqual(res.deleted, 2);
        assert.strictEqual(heldDuringWork, true);
        assert.strictEqual(held, false);   // released afterward
    });
});

describe('retention: full sweep', () => {
    it('is a no-op object when the policy is off', async () => {
        const db = makeDb();
        const cfg = R.parseRetentionConfig({});
        const res = await R.runSweep(db.query, 'BTC', 'regtest', cfg);
        assert.strictEqual(res.enabled, false);
        assert.strictEqual(db.roots.length, 2);
        assert.strictEqual(db.nodes.length, 4);
    });

    it('phase-1 only leaves nodes intact', async () => {
        const db = makeDb();
        const cfg = R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '50' });
        const res = await R.runSweep(db.query, 'BTC', 'regtest', cfg);
        assert.strictEqual(res.roots.deleted, 1);
        assert.strictEqual(res.nodes.skipped, true);
        assert.deepStrictEqual(db.roots.map(r => r.block_index), [100]);
        assert.strictEqual(db.nodes.length, 4);   // nodes untouched without opt-in
    });

    it('prunes roots THEN reclaims the freshly-orphaned nodes, in order', async () => {
        const db = makeDb();
        const cfg = R.parseRetentionConfig({ STATE_ROOT_RETENTION_BLOCKS: '50', STATE_NODE_RECLAIM: '1' });
        const res = await R.runSweep(db.query, 'BTC', 'regtest', cfg);
        assert.strictEqual(res.roots.deleted, 1);
        assert.strictEqual(res.nodes.deleted, 2);
        assert.deepStrictEqual(db.roots.map(r => r.block_index), [100]);
        assert.deepStrictEqual(db.nodes.map(n => n.node_hash).sort(), [A, B].sort());
    });
});

'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC, https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The equivalence oracle grades the state commitment tables once the launcher runs
// production's block passes. These tests build real sparse merkle trees through
// production's persistent SMT and require the oracle to ignore only what production
// treats as node-local (the computed_at wall clock, surrogate ids, node rows of
// orphaned trees no surviving root reaches, and chain-keyed root values across
// coins) while a differing root at a height, a leftover root row, or a node a
// surviving root needs still fails.

const assert = require('assert');

const M = require('../../../src/consensus/merkle.js');
const { PersistentSMT, MemoryNodeStore } = require('../../../src/state_commitment/persistent_smt.js');
const { leafOrNull } = require('../../../src/state_commitment/leaf_values.js');
const eq = require('../../integration/setup/equivalence.js');

const NETWORK = 'regtest';
const EMPTY_ROOT = M.toHex(M.EMPTY_SMT_ROOT);
const ALICE = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu';
const BOB = 'n4nbVcRRR5sEHyp2VYuLUvCyDmQmBoonoK';

// Apply balance updates block by block into one shared store, the way the block
// path threads each block's root into the next. Returns the per-block balances
// roots and the store holding every node any update wrote.
async function buildChain(chain, blocks, store = new MemoryNodeStore()) {
    const smt = new PersistentSMT(store);
    let root = EMPTY_ROOT;
    const roots = [];
    for (const updates of blocks) {
        for (const [address, tick, amount] of updates) {
            root = await smt.update(root, M.balanceKey(chain, NETWORK, address, tick), leafOrNull(amount));
        }
        roots.push(root);
    }
    return { roots, store };
}

// state_tree_nodes rows in insertion order, ids from `firstId`.
function nodeRows(store, firstId = 1) {
    return [...store.map.entries()].map(([hash, n], i) => ({
        id: String(firstId + i), node_hash: hash, left_hash: n.left_hash, right_hash: n.right_hash,
    }));
}

// One state_tree_roots row per height, starting at block 100.
function rootRows(chain, balancesRoots, stampSeconds, firstId = 1) {
    return balancesRoots.map((root, i) => ({
        id: String(firstId + i), chain, network: NETWORK, block_index: String(100 + i),
        balances_root: root, stakes_root: EMPTY_ROOT, state_root: M.toHex(M.sha256(chain + root)),
        block_merkle_root: M.toHex(M.sha256('block' + i)), contract_state_root: null,
        contract_state_root_shadow: null, balances_root_escrow_shadow: null,
        computed_at: new Date((1700000000 + stampSeconds + i) * 1000),
    }));
}

// A query function over in-memory tables, answering the two statements the oracle issues.
function fakeDb(tables) {
    return async (sql) => {
        if (sql === 'SHOW TABLES') return Object.keys(tables).map(t => ({ Tables_in_db: t }));
        const m = /^SELECT \* FROM `(\w+)`$/.exec(sql);
        if (!m) throw new Error('unexpected statement: ' + sql);
        return tables[m[1]].map(r => ({ ...r }));
    };
}

const BLOCKS = [
    [[ALICE, 'XCHAIN', '10'], [BOB, 'XCHAIN', '5']],
    [[ALICE, 'XCHAIN', '7'], [BOB, 'XCHAIN', '8']],
];

describe('equivalence oracle: state tree tables', function () {
    describe('strict mode (identical processing histories)', function () {
        it('accepts two nodes whose root rows differ only in computed_at', async function () {
            const { roots, store } = await buildChain('BTC', BLOCKS);
            const a = fakeDb({ state_tree_roots: rootRows('BTC', roots, 0), state_tree_nodes: nodeRows(store) });
            const b = fakeDb({ state_tree_roots: rootRows('BTC', roots, 90), state_tree_nodes: nodeRows(store) });
            await eq.assertIndexerDbsEquivalent(a, b, { mode: 'strict' });
        });

        it('rejects a differing balances_root at the same height', async function () {
            const { roots, store } = await buildChain('BTC', BLOCKS);
            const corrupt = rootRows('BTC', roots, 0);
            corrupt[1].balances_root = corrupt[1].balances_root.replace(/^./, c => (c === '0' ? '1' : '0'));
            const a = fakeDb({ state_tree_roots: rootRows('BTC', roots, 0), state_tree_nodes: nodeRows(store) });
            const b = fakeDb({ state_tree_roots: corrupt, state_tree_nodes: nodeRows(store) });
            await assert.rejects(eq.assertIndexerDbsEquivalent(a, b, { mode: 'strict' }),
                err => /NOT strict-equivalent in state_tree_roots/.test(err.message) &&
                    err.message.includes(corrupt[1].balances_root));
        });

        it('still compares node ids byte for byte', async function () {
            const { roots, store } = await buildChain('BTC', BLOCKS);
            const a = fakeDb({ state_tree_roots: rootRows('BTC', roots, 0), state_tree_nodes: nodeRows(store) });
            const b = fakeDb({ state_tree_roots: rootRows('BTC', roots, 0), state_tree_nodes: nodeRows(store, 9) });
            await assert.rejects(eq.assertIndexerDbsEquivalent(a, b, { mode: 'strict' }),
                /NOT strict-equivalent in state_tree_nodes/);
        });
    });

    describe('content mode (reorg survivor against a fresh re-parse)', function () {
        // The survivor applied an orphaned block 101 (BOB to 99) into the same store,
        // rolled its root row back, and then applied the surviving block 101.
        async function survivorAndFresh() {
            const orphan = await buildChain('BTC', [BLOCKS[0], [[BOB, 'XCHAIN', '99']]]);
            const survivor = await buildChain('BTC', [BLOCKS[0]]);
            for (const [hash, n] of orphan.store.map) survivor.store.map.set(hash, n);
            const smt = new PersistentSMT(survivor.store);
            let root = survivor.roots[0];
            for (const [address, tick, amount] of BLOCKS[1]) {
                root = await smt.update(root, M.balanceKey('BTC', NETWORK, address, tick), leafOrNull(amount));
            }
            const fresh = await buildChain('BTC', BLOCKS);
            assert.strictEqual(root, fresh.roots[1], 'fixture: both sides commit the same block 101 root');
            assert.ok(survivor.store.size > fresh.store.size, 'fixture: the survivor holds orphaned nodes');
            return {
                survivorRoots: rootRows('BTC', fresh.roots, 0, 5), survivorNodes: nodeRows(survivor.store, 40),
                freshRoots: rootRows('BTC', fresh.roots, 60), freshNodes: nodeRows(fresh.store),
                orphanRoot: orphan.roots[1],
            };
        }
        const content = { mode: 'content', labelA: 'survivor', labelB: 'resync' };

        it('accepts orphaned node residue no surviving root reaches', async function () {
            const f = await survivorAndFresh();
            await eq.assertIndexerDbsEquivalent(
                fakeDb({ state_tree_roots: f.survivorRoots, state_tree_nodes: f.survivorNodes }),
                fakeDb({ state_tree_roots: f.freshRoots, state_tree_nodes: f.freshNodes }), content);
        });

        it('rejects a root row left above the fork by a rollback', async function () {
            const f = await survivorAndFresh();
            const leftover = rootRows('BTC', [f.orphanRoot], 0, 9).map(r => ({ ...r, block_index: '102' }));
            await assert.rejects(eq.assertIndexerDbsEquivalent(
                fakeDb({ state_tree_roots: f.survivorRoots.concat(leftover), state_tree_nodes: f.survivorNodes }),
                fakeDb({ state_tree_roots: f.freshRoots, state_tree_nodes: f.freshNodes }), content),
            // The leftover root also makes its orphaned nodes reachable again.
            /NOT content-equivalent in state_tree_nodes, state_tree_roots:/);
        });

        it('rejects a differing balances_root at the same height', async function () {
            const f = await survivorAndFresh();
            const forked = f.survivorRoots.map((r, i) => (i === 1 ? { ...r, balances_root: f.orphanRoot } : r));
            await assert.rejects(eq.assertIndexerDbsEquivalent(
                fakeDb({ state_tree_roots: forked, state_tree_nodes: f.survivorNodes }),
                fakeDb({ state_tree_roots: f.freshRoots, state_tree_nodes: f.freshNodes }), content),
            err => /state_tree_roots/.test(err.message) && err.message.includes(f.orphanRoot));
        });

        it('rejects a survivor missing a node its surviving root reaches', async function () {
            const f = await survivorAndFresh();
            const top = f.freshRoots[1].balances_root;
            const nodes = f.survivorNodes.filter(n => n.node_hash !== top);
            await assert.rejects(eq.assertIndexerDbsEquivalent(
                fakeDb({ state_tree_roots: f.survivorRoots, state_tree_nodes: nodes }),
                fakeDb({ state_tree_roots: f.freshRoots, state_tree_nodes: f.freshNodes }), content),
            err => /state_tree_nodes/.test(err.message) && /unresolved in survivor/.test(err.message));
        });

        it('rejects a fresh node the survivor does not hold', async function () {
            const f = await survivorAndFresh();
            const stray = { id: '999', node_hash: 'ab'.repeat(32), left_hash: 'cd'.repeat(32), right_hash: 'ef'.repeat(32) };
            await assert.rejects(eq.assertIndexerDbsEquivalent(
                fakeDb({ state_tree_roots: f.survivorRoots, state_tree_nodes: f.survivorNodes }),
                fakeDb({ state_tree_roots: f.freshRoots, state_tree_nodes: f.freshNodes.concat(stray) }), content),
            err => /state_tree_nodes/.test(err.message) && err.message.includes(stray.node_hash));
        });
    });

    describe('captured states across coins', function () {
        async function captured(chain, mutate = t => t) {
            const { roots, store } = await buildChain(chain, BLOCKS);
            const firstId = chain === 'BTC' ? 1 : 3;
            return eq.captureDbState(fakeDb(mutate({
                state_tree_roots: rootRows(chain, roots, chain.length * 30),
                state_tree_nodes: nodeRows(store, firstId),
            })));
        }
        // Cross-coin grading is opt-in; the same labels without the flag are strict.
        const labels = { labelA: 'BTC', labelB: 'LTC', crossChain: true };
        const strictLabels = { labelA: 'BTC', labelB: 'LTC' };

        it('accepts chain-keyed roots and node ids that differ only by coin', async function () {
            const btc = await captured('BTC');
            const ltc = await captured('LTC');
            assert.notDeepStrictEqual(btc.state_tree_roots, ltc.state_tree_roots, 'fixture: roots differ by coin');
            eq.assertCapturedStatesEqual(btc, ltc, labels);
        });

        it('rejects a differing block_merkle_root at a height', async function () {
            const btc = await captured('BTC');
            const ltc = await captured('LTC', t => {
                t.state_tree_roots[1].block_merkle_root = 'ff'.repeat(32);
                return t;
            });
            assert.throws(() => eq.assertCapturedStatesEqual(btc, ltc, labels),
                err => /state_tree_roots/.test(err.message) && err.message.includes('ff'.repeat(32)));
        });

        it('rejects a coin missing a root row at a height', async function () {
            const btc = await captured('BTC');
            const ltc = await captured('LTC', t => ({ ...t, state_tree_roots: t.state_tree_roots.slice(0, 1) }));
            assert.throws(() => eq.assertCapturedStatesEqual(btc, ltc, labels), /state_tree_roots/);
        });

        it('rejects a coin whose chain-keyed slot is committed where the other is empty', async function () {
            const btc = await captured('BTC');
            const ltc = await captured('LTC', t => {
                t.state_tree_roots[0].contract_state_root = EMPTY_ROOT;
                return t;
            });
            assert.throws(() => eq.assertCapturedStatesEqual(btc, ltc, labels), /state_tree_roots/);
        });

        it('rejects a coin whose node store cannot resolve its own roots', async function () {
            const btc = await captured('BTC');
            const ltc = await captured('LTC', t => {
                const top = t.state_tree_roots[1].balances_root;
                return { ...t, state_tree_nodes: t.state_tree_nodes.filter(n => n.node_hash !== top) };
            });
            assert.throws(() => eq.assertCapturedStatesEqual(btc, ltc, labels),
                err => /state_tree_nodes/.test(err.message) && /unresolved in LTC/.test(err.message));
        });

        it('keeps the byte comparison when both states are the same coin', async function () {
            const a = await captured('BTC');
            const b = await captured('BTC', t => {
                t.state_tree_roots[0].balances_root = t.state_tree_roots[1].balances_root;
                return t;
            });
            assert.throws(() => eq.assertCapturedStatesEqual(a, b, strictLabels), /state_tree_roots/);
        });

        it('refuses captures of different chains without crossChain', async function () {
            const btc = await captured('BTC');
            const ltc = await captured('LTC');
            assert.throws(() => eq.assertCapturedStatesEqual(btc, ltc, strictLabels),
                err => err.message.includes('BTC=BTC') && err.message.includes('LTC=LTC') &&
                    /different chains/.test(err.message));
        });

        it('refuses a same-coin capture whose chain literal is wrong on one side', async function () {
            const a = await captured('BTC');
            const b = await captured('BTC', t => {
                t.state_tree_roots.forEach(r => { r.chain = 'LTC'; });
                return t;
            });
            assert.throws(() => eq.assertCapturedStatesEqual(a, b, strictLabels),
                err => /different chains/.test(err.message) && err.message.includes('LTC=LTC'));
        });

        it('refuses crossChain when both captures carry the same chain', async function () {
            const a = await captured('BTC');
            const b = await captured('BTC');
            assert.throws(() => eq.assertCapturedStatesEqual(a, b, labels),
                err => /two distinct chain literals/.test(err.message) &&
                    err.message.includes('BTC=BTC') && err.message.includes('LTC=BTC'));
        });

        it('refuses crossChain when a capture carries no chain literal', async function () {
            const btc = await captured('BTC');
            const empty = await captured('LTC', t => ({ ...t, state_tree_roots: [] }));
            assert.throws(() => eq.assertCapturedStatesEqual(btc, empty, labels),
                err => /two distinct chain literals/.test(err.message) && err.message.includes('LTC=null'));
        });
    });
});

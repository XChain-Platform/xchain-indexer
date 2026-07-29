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
 * Persistent SMT engine conformance (SPV spec §4). Asserts the incremental,
 * content-addressed PersistentSMT produces byte-identical roots to the in-memory
 * SparseMerkleTree reference in merkle.js across inserts, updates, and deletes,
 * and that proofs generated from the persistent store verify. Deterministic
 * inputs (sha256(i)) so any failure reproduces exactly. No DB required.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const M  = require('../../src/merkle.js');
const SC = require('../../src/stateCommitment.js');

// Deterministic pseudo-random key + amount derived from an index.
function keyFor(i){ return M.sha256(Buffer.from('key:' + i, 'utf8')); }            // 32-byte key buf
function amountFor(i){ return String((i * 7 + 1)) + '.' + String(100000 + i).slice(0, 6); }
function leafFor(i){ return M.toHex(M.amountLeaf(amountFor(i))); }

describe('stateCommitment: persistent SMT == in-memory reference @regression', function(){

    it('empty tree root matches EMPTY_SMT_ROOT', async function(){
        const smt = new SC.PersistentSMT(new SC.MemoryNodeStore());
        assert.strictEqual(SC.EMPTY_ROOT_HEX, M.toHex(M.EMPTY_SMT_ROOT));
        // an empty persistent tree (no updates) is the empty root by definition
        assert.strictEqual(await smt.prove(SC.EMPTY_ROOT_HEX, keyFor(0)).then(p => p.leaf_value), null);
    });

    it('matches the reference root after each insert', async function(){
        const ref = new M.SparseMerkleTree();
        const smt = new SC.PersistentSMT(new SC.MemoryNodeStore());
        let root = SC.EMPTY_ROOT_HEX;
        for(let i = 0; i < 40; i++){
            const k = keyFor(i), leaf = leafFor(i);
            ref.set(k, M.toBuf(leaf));
            root = await smt.update(root, k, leaf);
            assert.strictEqual(root, ref.rootHex(), 'root diverged after insert ' + i);
        }
    });

    it('matches the reference through updates and deletes (return-to-zero)', async function(){
        const ref = new M.SparseMerkleTree();
        const smt = new SC.PersistentSMT(new SC.MemoryNodeStore());
        let root = SC.EMPTY_ROOT_HEX;
        for(let i = 0; i < 30; i++){
            const k = keyFor(i), leaf = leafFor(i);
            ref.set(k, M.toBuf(leaf));
            root = await smt.update(root, k, leaf);
        }
        assert.strictEqual(root, ref.rootHex());
        for(let i = 0; i < 30; i += 2){
            const k = keyFor(i), leaf = leafFor(i + 1000);
            ref.set(k, M.toBuf(leaf));
            root = await smt.update(root, k, leaf);
            assert.strictEqual(root, ref.rootHex(), 'root diverged after update ' + i);
        }
        // return-to-zero: null leaf on persistent, delete on ref
        for(let i = 0; i < 30; i += 3){
            const k = keyFor(i);
            ref.delete(k);
            root = await smt.update(root, k, null);
            assert.strictEqual(root, ref.rootHex(), 'root diverged after delete ' + i);
        }
        for(let i = 0; i < 30; i++){
            const k = keyFor(i);
            if(ref.has(k)){ ref.delete(k); root = await smt.update(root, k, null); }
        }
        assert.strictEqual(root, SC.EMPTY_ROOT_HEX, 'fully-emptied tree must return to EMPTY_SMT_ROOT');
        assert.strictEqual(root, ref.rootHex());
    });

    it('insert order does not affect the root (content-addressed convergence)', async function(){
        const a = new SC.PersistentSMT(new SC.MemoryNodeStore());
        const b = new SC.PersistentSMT(new SC.MemoryNodeStore());
        let ra = SC.EMPTY_ROOT_HEX, rb = SC.EMPTY_ROOT_HEX;
        const order = [5, 1, 9, 3, 7, 0, 8, 2, 6, 4];
        for(let i = 0; i < 10; i++)         ra = await a.update(ra, keyFor(i), leafFor(i));        // ascending
        for(const i of order)                rb = await b.update(rb, keyFor(i), leafFor(i));        // shuffled
        assert.strictEqual(ra, rb);
    });

    it('buildFull equals sequential update', async function(){
        const entries = [];
        for(let i = 0; i < 25; i++) entries.push([M.toHex(keyFor(i)), leafFor(i)]);
        const full = await new SC.PersistentSMT(new SC.MemoryNodeStore()).buildFull(entries);
        const ref = new M.SparseMerkleTree();
        for(let i = 0; i < 25; i++) ref.set(keyFor(i), M.toBuf(leafFor(i)));
        assert.strictEqual(full, ref.rootHex());
    });

    it('proofs from the persistent store verify (membership + non-membership)', async function(){
        const smt = new SC.PersistentSMT(new SC.MemoryNodeStore());
        let root = SC.EMPTY_ROOT_HEX;
        for(let i = 0; i < 20; i++) root = await smt.update(root, keyFor(i), leafFor(i));
        // membership
        const pm = await smt.prove(root, keyFor(7));
        assert.strictEqual(pm.leaf_value, leafFor(7));
        assert.ok(M.verifyCompressedSmtProof(root, keyFor(7), pm.leaf_value, pm.compressed));
        // non-membership
        const pn = await smt.prove(root, keyFor(9999));
        assert.strictEqual(pn.leaf_value, null);
        assert.ok(M.verifyCompressedSmtProof(root, keyFor(9999), null, pn.compressed));
        // a tampered value fails
        assert.ok(!M.verifyCompressedSmtProof(root, keyFor(7), leafFor(8), pm.compressed));
    });

    it('assembleStateRoot matches merkle.stateRoot', async function(){
        const bal = leafFor(1), stk = leafFor(2);   // arbitrary 32-byte sub-roots
        assert.strictEqual(SC.assembleStateRoot(bal, stk),
                           M.toHex(M.stateRoot({ balances_root: bal, stakes_root: stk })));
    });
});

describe('state-commitment flag-day activation @regression', function(){
    const act = require('../../src/state_commitment_activation.js');

    it('gates on the local block_index per chain', function(){
        assert.strictEqual(act.isStateCommitmentActive(0, 'regtest'), true);
        assert.strictEqual(act.isStateCommitmentActive(0, 'testnet', 'BTC'), false);   // below the armed testnet height
        assert.strictEqual(act.isStateCommitmentActive(145000, 'testnet', 'BTC'), true);
        assert.strictEqual(act.isStateCommitmentActive(958499, 'mainnet', 'BTC'), false);  // one below the armed height
        assert.strictEqual(act.isStateCommitmentActive(958500, 'mainnet', 'BTC'), true);
        assert.strictEqual(act.isStateCommitmentActive(6291000, 'mainnet', 'DOGE'), true);
        assert.strictEqual(act.isStateCommitmentActive(6291000, 'mainnet', 'LTC'), true);  // LTC armed lower
        assert.strictEqual(act.isStateCommitmentActive(5, 'mainnet'), false);       // coin-less mainnet -> inert
        assert.strictEqual(act.isStateCommitmentActive(0, 'bogusnet'), false);      // unknown -> off
    });

    it('flags only the single activation boundary block', function(){
        // regtest activates at 0: block 0 is the boundary (0 active, -1 inactive)
        assert.strictEqual(act.isStateCommitmentActivationBlock(0, 'regtest'), true);
        assert.strictEqual(act.isStateCommitmentActivationBlock(1, 'regtest'), false);
        // mid-chain arming: the armed height itself is the boundary
        assert.strictEqual(act.isStateCommitmentActivationBlock(958500, 'mainnet', 'BTC'), true);
        assert.strictEqual(act.isStateCommitmentActivationBlock(958501, 'mainnet', 'BTC'), false);
    });

    // Cross-service parity: the indexer's LOCAL activation map must equal the
    // canonical map in xchain-documentation/protocol/constants.js (drift = the
    // indexer and the xchain-sync follower flip the additive root on different
    // blocks -> guaranteed state_root divergence HALT). Monorepo-relative: the
    // canonical doc is present in the monorepo/aggregator checkout but NOT in
    // standalone single-repo CI. The skip is GATED like the xchain-sync twin
    // (see its stateCommitment.test.js): the e2e job that checks out
    // xchain-documentation sets XCHAIN_REQUIRE_SIBLINGS=1, where a missing
    // canonical doc HARD-FAILS instead of skipping, so this parity assertion can
    // never green-by-skip where the sibling is required. Standalone CI (flag
    // unset, no sibling) still skips.
    it('indexer activation map == canonical constants.js', function(){
        let canonical;
        try { canonical = require('../../../xchain-documentation/protocol/constants.js').STATE_COMMITMENT_ACTIVATION; }
        catch (e) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('consensus parity guard cannot run: xchain-documentation sibling missing (' + e.message + ')');
            return this.skip();
        }
        assert.deepStrictEqual(act.STATE_COMMITMENT_ACTIVATION, canonical);
    });
});

// Mock db that backs state_tree_nodes in memory and routes computeAndStoreRoots'
// other queries by SQL shape. chain LTC keeps the BTC-only stakes path out.
function makeRootsMockDb({ priorRows, balances }){
    const nodes = new Map();
    const persisted = {};
    const route = async (sql, params) => {
        if(/FROM state_tree_nodes/.test(sql)){
            const v = nodes.get(params[0]);
            return v ? [v] : [];
        }
        if(/INSERT IGNORE INTO state_tree_nodes/.test(sql)){
            if(!nodes.has(params[0]))
                nodes.set(params[0], { left_hash: params[1], right_hash: params[2] });
            return [];
        }
        if(/SELECT balances_root FROM state_tree_roots/.test(sql)){
            return priorRows;
        }
        if(/UNION ALL/.test(sql) && /credits/.test(sql)){
            return balances;   // buildFullBalancesRoot net-balance scan
        }
        if(/INSERT INTO\s+state_tree_roots/.test(sql)){
            // [chain, network, blockIndex, balances_root, stakes_root, state_root, block_merkle_root]
            persisted.balances_root = params[3];
            persisted.state_root    = params[5];
            return [];
        }
        return [];
    };
    // Both readers: computeAndStoreRoots reads strictly (M-17), and a stub
    // carrying only doQuery would fail with "not a function" rather than
    // exercising the fallback this suite is about.
    const db = {
        getBlockLeafRows: async () => [],
        doQuery: route,
        doQueryStrict: route
    };
    return { db, persisted };
}

describe('stateCommitment: missing prior root falls back to full recompute (item 4500) @regression', function(){
    const balances = [
        { address: 'addr1', tick: 'TICK', net: '100' },
        { address: 'addr2', tick: 'TICK', net: '50' }
    ];

    it('full-recomputes balances_root (not EMPTY) when the prior block row is absent', async function(){
        const { db, persisted } = makeRootsMockDb({ priorRows: [], balances });
        const out = await SC.computeAndStoreRoots(db, 'LTC', 'mainnet', 500, false);

        // Ground truth: a full build over the same net-balance set.
        const { db: refDb } = makeRootsMockDb({ priorRows: [], balances });
        const expected = await SC.buildFullBalancesRoot(refDb, 'LTC', 'mainnet');

        assert.strictEqual(out.balances_root, expected);
        assert.strictEqual(persisted.balances_root, expected);
        assert.notStrictEqual(out.balances_root, SC.EMPTY_ROOT_HEX,
            'missing prior must NOT silently thread from the empty root');
    });

    it('still threads incrementally from the prior root when the prior block row is present', async function(){
        // Prior root present + no touched keys -> incremental path returns the
        // prior root verbatim (EMPTY here), distinct from the non-empty full build.
        const { db } = makeRootsMockDb({ priorRows: [{ balances_root: SC.EMPTY_ROOT_HEX }], balances });
        const out = await SC.computeAndStoreRoots(db, 'LTC', 'mainnet', 500, false);
        assert.strictEqual(out.balances_root, SC.EMPTY_ROOT_HEX);
    });
});

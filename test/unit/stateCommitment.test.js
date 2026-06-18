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
        // seed 30 keys
        for(let i = 0; i < 30; i++){
            const k = keyFor(i), leaf = leafFor(i);
            ref.set(k, M.toBuf(leaf));
            root = await smt.update(root, k, leaf);
        }
        assert.strictEqual(root, ref.rootHex());
        // update half to new values
        for(let i = 0; i < 30; i += 2){
            const k = keyFor(i), leaf = leafFor(i + 1000);
            ref.set(k, M.toBuf(leaf));
            root = await smt.update(root, k, leaf);
            assert.strictEqual(root, ref.rootHex(), 'root diverged after update ' + i);
        }
        // delete a third of them (return-to-zero => null leaf on persistent, delete on ref)
        for(let i = 0; i < 30; i += 3){
            const k = keyFor(i);
            ref.delete(k);
            root = await smt.update(root, k, null);
            assert.strictEqual(root, ref.rootHex(), 'root diverged after delete ' + i);
        }
        // delete everything: must collapse back to EMPTY_SMT_ROOT
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

    it('gates on the local block_index per network', function(){
        assert.strictEqual(act.isStateCommitmentActive(0, 'regtest'), true);
        assert.strictEqual(act.isStateCommitmentActive(0, 'testnet'), true);
        assert.strictEqual(act.isStateCommitmentActive(5, 'mainnet'), false);   // placeholder height
        assert.strictEqual(act.isStateCommitmentActive(0, 'bogusnet'), false);  // unknown -> off
    });

    it('flags only the single activation boundary block', function(){
        // regtest activates at 0: block 0 is the boundary (0 active, -1 inactive)
        assert.strictEqual(act.isStateCommitmentActivationBlock(0, 'regtest'), true);
        assert.strictEqual(act.isStateCommitmentActivationBlock(1, 'regtest'), false);
    });

    // Cross-service parity: the indexer's LOCAL activation map must equal the
    // canonical map in xchain-documentation/protocol/constants.js (drift = the
    // indexer and the xchain-sync follower flip the additive root on different
    // blocks -> guaranteed state_root divergence HALT). A missing canonical is a
    // hard failure, never a silent skip.
    it('indexer activation map == canonical constants.js', function(){
        const canonical = require('../../../xchain-documentation/protocol/constants.js')
            .STATE_COMMITMENT_ACTIVATION;
        assert.deepStrictEqual(act.STATE_COMMITMENT_ACTIVATION, canonical);
    });
});

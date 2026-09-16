/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * contract_state_root derivation conformance for the SPV state sub-tree
 * (its contract-state half).
 *
 * Four jobs, in descending order of what they would cost if they failed:
 *
 * 1. INERTNESS. While every activation map is empty, the block paths must not
 *    merely commit the same root, they must not even ASK: the query counter
 *    asserts zero contract_state reads per block. That is what makes "landing
 *    this changes nothing on the fleet" a measurement rather than a claim.
 * 2. THE FROZEN ROW-TO-LEAF MAPPING, all four cases plus the ordering trap. The
 *    tombstone-vs-MAX(id) ordering is the single most forkable line in the
 *    stage and it is tested behaviourally AND pinned at the source level.
 * 3. INCREMENTAL == FULL BUILD. Every path that can produce a root for the same
 *    live state must produce the SAME root: incremental threading, the arming
 *    full build, and the snapshot bootstrap. A divergence here halts the
 *    follower on its first block after arming.
 * 4. THE REORG-ACROSS-THE-ARMED-HEIGHT VECTOR. Rolling back below the armed
 *    height must recommit the slot EMPTY and return state_root to the exact
 *    byte-for-byte v1 value; re-advancing must reproduce the armed root.
 *
 * STUB HONESTY, stated because it bounds what these vectors prove: the fake db
 * below implements the SEMANTICS of the three contract_state queries (latest
 * row by id, MAX(id) per key, distinct keys per block) over an in-memory row
 * array. It cannot catch a collation mistake, because JS string comparison is
 * already byte-exact where MariaDB's utf8_general_ci is not. That specific
 * hazard (a fold of "Key"/"key" into one leaf) is therefore pinned separately
 * as a SOURCE assertion that every query names state_key_bin, and structurally
 * by the spec precondition that Stage A may not arm below the collation height.
 *
 * TWIN PAIR: this ENTRY file and xchain-sync/test/unit/contractStateSubtree.test.js
 * are kept BYTE-IDENTICAL apart from the src/<feature>/ depth of their requires.
 * Locked equal by the cross-repo twin loop in
 * xchain-sync/test/unit/rollback-coverage.test.js. The suite outgrew the
 * file-length limit, so the frozen-mapping tail, key derivation, incremental,
 * shadow-window, arming-boundary and strict-read blocks now sit beside it in
 * contract_state_subtree.test/. That parts directory is NOT in the twin registry,
 * so a change there reaches the sync half only by hand or reconcile-twins.sh.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const M   = require('../../src/consensus/merkle.js');
const SC  = require('../../src/state_commitment/index.js');
const SUB = require('../../src/state_subtree_activation.js');
const CST = require('../../src/consensus/contract_state_subtree.js');

const CHAIN = 'BTC', NETWORK = 'regtest';

// ---- Fake db ---------------------------------------------------------------
// Rows are appended exactly as the indexer appends them: id ascending, one row
// per write, state_value = null for a VM delete. state_key_bin is modelled as
// the identical string (see STUB HONESTY above).
class FakeDb {
    constructor(){
        this.rows   = [];          // contract_state
        this.roots  = new Map();   // block_index -> { contract_state_root }
        this.nodes  = new Map();   // state_tree_nodes
        this.nextId = 1;
        this.stateQueries = 0;     // every contract_state read, for the inertness count
        // Which reader each SQL string arrived through. The derivation must
        // use doQueryStrict for ALL of its reads, because doQuery collapses a
        // non-transactional error into [] and every [] here is a meaningful (and
        // wrong) answer rather than an error signal.
        this.softSql   = [];
        this.strictSql = [];
        this.failOn    = null;     // substring: reads matching it throw, for fault injection
    }
    write(blockIndex, contractIndex, stateKey, stateValue){
        this.rows.push({ id: this.nextId++, contract_index: contractIndex,
                         state_key: stateKey, state_value: stateValue, block_index: blockIndex });
    }
    // Reorg: contract_state and state_tree_roots are both rollback:'block'.
    rollbackTo(height){
        this.rows = this.rows.filter(r => r.block_index < height);
        for(const k of Array.from(this.roots.keys())) if(k >= height) this.roots.delete(k);
    }
    storeRoot(blockIndex, contractStateRoot){
        const row = this.roots.get(blockIndex) || {};
        row.contract_state_root = contractStateRoot;
        this.roots.set(blockIndex, row);
    }
    // The shadow column: a separate value on the same row, deliberately not the
    // committed one (the explorer reassembles proofs from that).
    storeShadow(blockIndex, shadowRoot){
        const row = this.roots.get(blockIndex) || {};
        row.contract_state_root_shadow = shadowRoot;
        this.roots.set(blockIndex, row);
    }
    // One node store per NODE, shared by every block, exactly as DbNodeStore over
    // state_tree_nodes is. Handing each block a fresh store instead makes the
    // incremental thread silently start from a blank tree, because _descend reads
    // a missing row as an empty subtree: the root still looks like a hash, and
    // only the full-build comparison catches it.
    smt(){
        const self = this;
        return new SC.PersistentSMT({
            async get(h){ return self.nodes.has(h) ? self.nodes.get(h) : null; },
            async put(h, l, r){ if(!self.nodes.has(h)) self.nodes.set(h, { left_hash: l, right_hash: r }); }
        });
    }
    // The two readers are deliberately NOT one method: the node store
    // (stateCommitment's DbNodeStore) legitimately uses doQuery, so recording
    // which one each SQL string came through is what lets a vector prove the
    // derivation's own reads went strict.
    async doQuery(sql, args){
        this.softSql.push(sql);
        return await this.run(sql, args);
    }
    async doQueryStrict(sql, args){
        this.strictSql.push(sql);
        return await this.run(sql, args);
    }
    // Dispatch by table. Each table's semantics live in their own method below,
    // and none of them awaits anything: the fake answers synchronously, so the
    // only suspension a caller sees is the one on doQuery / doQueryStrict.
    async run(sql, args){
        // Fault injection: model a transient DB fault. doQueryStrict propagates
        // it; doQuery would have swallowed it into [] outside a transaction.
        if(this.failOn && sql.indexOf(this.failOn) !== -1)
            throw new Error('injected DB fault');
        if(sql.indexOf('state_tree_nodes') !== -1) return this.runNodeStore(sql, args);
        if(sql.indexOf('FROM state_tree_roots') !== -1) return this.runRootsRead(sql, args);
        if(sql.indexOf('FROM contract_state') !== -1) return this.runContractState(sql, args);
        throw new Error('FakeDb: unexpected query ' + sql.slice(0, 60));
    }
    runNodeStore(sql, args){
        if(sql.indexOf('INSERT') === 0 || sql.indexOf('INSERT') > -1 && sql.indexOf('SELECT') === -1){
            // Consume args in (hash, left, right) TRIPLES, not just the first
            // one: DbNodeStore.putMany batches a whole path into one multi-row
            // INSERT IGNORE. Reading only args[0..2] would store row
            // one and silently drop the rest, and a fake that drops writes does
            // not fail loudly - _descend reads a missing node as an EMPTY
            // subtree, so the next block emits a truncated root that still
            // looks like a hash. That is the exact fault this file's own
            // `smt()` comment warns about, arriving through the DB fake instead.
            for(let i = 0; i + 2 < args.length; i += 3)
                if(!this.nodes.has(args[i]))
                    this.nodes.set(args[i], { left_hash: args[i + 1], right_hash: args[i + 2] });
            return [];
        }
        const n = this.nodes.get(args[0]);
        return n ? [n] : [];
    }
    runRootsRead(sql, args){
        // The derivation selects ONE column aliased to `r`, choosing committed
        // vs shadow by which name the SQL carries. Honour that here, or the
        // shadow tests would silently read the committed column.
        const row = this.roots.get(args[2]);
        if(!row) return [];
        const col = (sql.indexOf('contract_state_root_shadow') !== -1)
            ? 'contract_state_root_shadow' : 'contract_state_root';
        return [{ r: (row[col] == null) ? null : row[col] }];
    }
    runContractState(sql, args){
        this.stateQueries++;
        // Distinct keys written by one block.
        if(sql.indexOf('SELECT DISTINCT') === 0){
            const seen = new Map();
            for(const r of this.rows)
                if(r.block_index === args[0])
                    seen.set(r.contract_index + '' + r.state_key,
                             { contract_index: r.contract_index, state_key: r.state_key });
            return Array.from(seen.values());
        }
        // Latest row for one key: highest id wins, tombstones included.
        if(sql.indexOf('ORDER BY id DESC LIMIT 1') !== -1){
            let best = null;
            for(const r of this.rows)
                if(r.contract_index === args[0] && r.state_key === args[1] && (!best || r.id > best.id)) best = r;
            return best ? [{ state_value: best.state_value }] : [];
        }
        // Full live set: MAX(id) per (contract_index, state_key), tombstones
        // NOT filtered here (the caller applies the mapping).
        const max = new Map();
        for(const r of this.rows){
            const k = r.contract_index + '' + r.state_key;
            const cur = max.get(k);
            if(!cur || r.id > cur.id) max.set(k, r);
        }
        return Array.from(max.values()).map(r => ({ contract_index: r.contract_index,
                                                    state_key: r.state_key, state_value: r.state_value }));
    }
}

const EMPTY = CST.EMPTY_ROOT_HEX;

// Arm contract_state_root at `height` for the duration of fn, then restore.
async function armedAt(height, fn){
    const map = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root;
    const __k0 = CHAIN + ':' + NETWORK;
    const __hadPrior = Object.prototype.hasOwnProperty.call(map, __k0), __prior = map[__k0];
    map[CHAIN + ':' + NETWORK] = height;
    try { return await fn(); } finally {
        // RESTORE, never delete: a real armed height lives in this map now, and
        // deleting the key would disarm the chain for every later test in the
        // process (which is exactly how a green suite once hid a wrong answer).
        const __k = CHAIN + ':' + NETWORK;
        if(__hadPrior) map[__k] = __prior; else delete map[__k];
    }
}

describe('contract_state_root: inertness @regression', function(){

    it('the activation maps hold exactly the armed set, and MAINNET is untouched', function(){
        // Was "every map is still empty", which was correct while nothing was
        // armed and had to be replaced (not deleted) the moment regtest armed.
        // The mainnet half is the assertion that must never be relaxed.
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.ownership_root, {});
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.tokens_root, {});
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.contract_state_root,
            { 'BTC:regtest': 10000, 'BTC:testnet': 0, 'LTC:testnet': 0, 'DOGE:testnet': 0 });
        for(const slot of SUB.RESERVED_SUBTREES)
            for(const key of Object.keys(SUB.STATE_SUBTREE_ACTIVATION[slot]))
                assert.ok(!/mainnet/.test(key), slot + ' is armed on mainnet (' + key + ')');
    });
});

// Same title, continued: the readability limit splits the block, not the suite.
describe('contract_state_root: inertness @regression', function(){

    it('an INERT chain issues ZERO contract_state queries and offers no candidate', async function(){
        // Now scoped around the armed chain rather than deleted: every OTHER
        // chain must still cost nothing, which is what makes "nothing changes
        // until a height is armed" provable by inspection instead of argued.
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            for(const network of ['mainnet', 'testnet', 'regtest'])
                for(const h of [0, 1, 958500, 962500, 6335000, 999999999]){
                    // Skip every ARMED chain, derived from the map rather than a
                    // hardcoded pair: with four heights armed (BTC:regtest 10000 plus
                    // all three testnets at genesis) a hardcoded skip would quietly
                    // walk over a chain that DOES query, and assert the opposite of
                    // its own name. Deriving it also means the testnet chains dropped
                    // out of the inert sweep at the same commit that armed them.
                    const armedAt = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root[coin + ':' + network];
                    if(armedAt !== undefined && h >= armedAt) continue;                   // the armed chains
                    const db = new FakeDb();
                    db.write(h, 7, 'k', '"v"');   // real rows present, and still not read
                    const candidates = await SC.reservedSubRootCandidates(db, coin, network, h);
                    assert.strictEqual(candidates, null, coin + '/' + network + '@' + h);
                    assert.strictEqual(db.stateQueries, 0,
                        'inert chain must not query contract_state (' + coin + '/' + network + '@' + h + ')');
                }
    });

    it('the ARMED chain DOES query and DOES offer a candidate (the gate really opened)', async function(){
        // The other half of the same property. A gate that never opens would pass
        // every inertness assertion above, so the armed chain is checked directly.
        const db = new FakeDb();
        db.write(10000, 7, 'k', '"v"');
        const candidates = await SC.reservedSubRootCandidates(db, 'BTC', 'regtest', 10000);
        assert.ok(candidates && candidates.contract_state_root, 'armed chain must offer a candidate');
        assert.notStrictEqual(candidates.contract_state_root, SC.EMPTY_ROOT_HEX,
            'a chain with real contract state must not commit the empty root');
        assert.ok(db.stateQueries > 0, 'armed chain must read contract_state');
        // And one block below the height, the same db is untouched.
        const below = new FakeDb();
        below.write(9999, 7, 'k', '"v"');
        assert.strictEqual(await SC.reservedSubRootCandidates(below, 'BTC', 'regtest', 9999), null);
        assert.strictEqual(below.stateQueries, 0);
    });
});

// Same title, continued: the readability limit splits the block, not the suite.
describe('contract_state_root: inertness @regression', function(){

    it('every GENESIS-armed testnet chain queries from block 0, with no below-arming region', async function(){
        // LTC and DOGE testnet had no entry in this map at all before the genesis
        // arming, so nothing here exercised them and their removal would have been
        // invisible. A genesis height also has no "below" to check, which is exactly
        // why the block above keeps BTC:regtest's real boundary: between them the
        // gate is proven to open AND to still be capable of answering false.
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const db = new FakeDb();
            db.write(0, 7, 'k', '"v"');
            const candidates = await SC.reservedSubRootCandidates(db, coin, 'testnet', 0);
            assert.ok(candidates && candidates.contract_state_root,
                coin + ':testnet must offer a candidate at its first block');
            assert.ok(db.stateQueries > 0, coin + ':testnet must read contract_state at block 0');
        }
        // Mainnet is the control: the same call on the same coins reads nothing, so
        // the assertions above are about the armed map and not about the fake db.
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const db = new FakeDb();
            db.write(0, 7, 'k', '"v"');
            assert.strictEqual(await SC.reservedSubRootCandidates(db, coin, 'mainnet', 0), null);
            assert.strictEqual(db.stateQueries, 0, coin + ' mainnet must stay inert at block 0');
        }
    });

    it('an inert block stores NULL in the extension column, which is what EMPTY means', function(){
        assert.strictEqual(SC.extraSubRootColumn(null, 'contract_state_root'), null);
        assert.strictEqual(SC.extraSubRootColumn({}, 'contract_state_root'), null);
        // And a gated-through value is stored verbatim, so the column and the
        // state_root it reassembles to come from one value.
        const r = 'ab'.repeat(32);
        assert.strictEqual(SC.extraSubRootColumn({ contract_state_root: r }, 'contract_state_root'), r);
    });
});

describe('contract_state_root: frozen row-to-leaf mapping @regression', function(){

    it('an ordinary value hashes the RAW STORED STRING, never the JSON.parse form', function(){
        // getContractState JSON.parses with a raw fallback, so the parsed form is
        // not a function of the row alone. The stored bytes are.
        const stored = '"hello"';
        assert.strictEqual(CST.contractStateLeaf(stored), M.toHex(M.leafHash(stored)));
        assert.notStrictEqual(CST.contractStateLeaf(stored), M.toHex(M.leafHash('hello')));
    });

    it('a SQL-NULL state_value is the deletion tombstone: no leaf, never a hash of null or ""', function(){
        assert.strictEqual(CST.contractStateLeaf(null), null);
        assert.strictEqual(CST.contractStateLeaf(undefined), null);
        assert.notStrictEqual(CST.contractStateLeaf(''), null);
    });

    it('state_value = "" commits leafHash("") and is distinct from absent', function(){
        assert.strictEqual(CST.contractStateLeaf(''), M.toHex(M.leafHash('')));
        assert.notStrictEqual(CST.contractStateLeaf(''), CST.contractStateLeaf(null));
    });

    it('the tombstone mapping DIFFERS from the block-merkle mapping, deliberately', function(){
        // merkle.blockMerkleLeaves maps a NULL state_value to '' via _c(), because
        // block_merkle_root commits the exact rows a block wrote (tombstone rows
        // included) while contract_state_root commits LIVE state, from which a
        // tombstoned key is absent. Harmonising them would fork one of the two, so
        // the difference is asserted rather than left to be "fixed" later.
        const blockLeaves = M.blockMerkleLeaves({ contracts: { state: [
            { contract_index: 7, state_key: 'k', state_value: null } ] } });
        assert.strictEqual(blockLeaves.length, 1, 'the tombstone row IS committed by block_merkle_root');
        assert.strictEqual(CST.contractStateLeaf(null), null, 'and is NOT committed by contract_state_root');
    });

    it('MAX(id) runs over tombstones too: a deleted key stays deleted (the ordering trap)', async function(){
        // History: write, overwrite, delete. Filtering IS NOT NULL *before* the max
        // would resurrect the key at its last surviving write ('"v2"'). That
        // predicate move reads as a harmless optimisation and is a fork.
        const db = new FakeDb();
        db.write(10, 7, 'k', '"v1"');
        db.write(11, 7, 'k', '"v2"');
        db.write(12, 7, 'k', null);
        assert.strictEqual(await CST.latestStateValue(db, 7, 'k'), null);
        const root = await CST.buildFullContractStateRoot(db, db.smt(), CHAIN, NETWORK);
        assert.strictEqual(root, EMPTY, 'a tombstoned key must leave an EMPTY tree, not a leaf over "v2"');
    });

    it('a resurrected key comes back with its NEW value, not its pre-delete one', async function(){
        const db = new FakeDb();
        db.write(10, 7, 'k', '"v1"');
        db.write(11, 7, 'k', null);
        db.write(12, 7, 'k', '"v3"');
        assert.strictEqual(await CST.latestStateValue(db, 7, 'k'), '"v3"');
    });
});

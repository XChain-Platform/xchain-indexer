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
 * contract_state_root derivation conformance (SPV sub-tree spec §3 Stage A;
 * design in claude/specs/spv-state-subtree-extension.md).
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
 * TWIN PAIR: xchain-indexer/test/unit/contractStateSubtree.test.js and
 * xchain-sync/test/unit/contractStateSubtree.test.js are kept BYTE-IDENTICAL
 * (both repos resolve the same relative src paths). Locked equal by the
 * cross-repo twin loop in xchain-sync/test/unit/rollback-coverage.test.js.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const M   = require('../../src/merkle.js');
const SC  = require('../../src/stateCommitment.js');
const SUB = require('../../src/state_subtree_activation.js');
const CST = require('../../src/contractStateSubtree.js');

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
        // M-17: which reader each SQL string arrived through. The derivation must
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
    // The §7 shadow column: a separate value on the same row, deliberately not the
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
        return await this._run(sql, args);
    }
    async doQueryStrict(sql, args){
        this.strictSql.push(sql);
        return await this._run(sql, args);
    }
    async _run(sql, args){
        // Fault injection: model a transient DB fault. doQueryStrict propagates
        // it; doQuery would have swallowed it into [] outside a transaction.
        if(this.failOn && sql.indexOf(this.failOn) !== -1)
            throw new Error('injected DB fault');
        if(sql.indexOf('state_tree_nodes') !== -1){
            if(sql.indexOf('INSERT') === 0 || sql.indexOf('INSERT') > -1 && sql.indexOf('SELECT') === -1){
                if(!this.nodes.has(args[0])) this.nodes.set(args[0], { left_hash: args[1], right_hash: args[2] });
                return [];
            }
            const n = this.nodes.get(args[0]);
            return n ? [n] : [];
        }
        if(sql.indexOf('FROM state_tree_roots') !== -1){
            // The derivation selects ONE column aliased to `r`, choosing committed
            // vs shadow by which name the SQL carries. Honour that here, or the
            // shadow tests would silently read the committed column.
            const row = this.roots.get(args[2]);
            if(!row) return [];
            const col = (sql.indexOf('contract_state_root_shadow') !== -1)
                ? 'contract_state_root_shadow' : 'contract_state_root';
            return [{ r: (row[col] == null) ? null : row[col] }];
        }
        if(sql.indexOf('FROM contract_state') !== -1){
            this.stateQueries++;
            // Distinct keys written by one block.
            if(sql.indexOf('SELECT DISTINCT') === 0){
                const seen = new Map();
                for(const r of this.rows)
                    if(r.block_index === args[0])
                        seen.set(r.contract_index + '' + r.state_key,
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
                const k = r.contract_index + '' + r.state_key;
                const cur = max.get(k);
                if(!cur || r.id > cur.id) max.set(k, r);
            }
            return Array.from(max.values()).map(r => ({ contract_index: r.contract_index,
                                                        state_key: r.state_key, state_value: r.state_value }));
        }
        throw new Error('FakeDb: unexpected query ' + sql.slice(0, 60));
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
            { 'BTC:regtest': 10000, 'BTC:testnet': 146500 });
        for(const slot of SUB.RESERVED_SUBTREES)
            for(const key of Object.keys(SUB.STATE_SUBTREE_ACTIVATION[slot]))
                assert.ok(!/mainnet/.test(key), slot + ' is armed on mainnet (' + key + ')');
    });

    it('an INERT chain issues ZERO contract_state queries and offers no candidate', async function(){
        // Now scoped around the armed chain rather than deleted: every OTHER
        // chain must still cost nothing, which is what makes "nothing changes
        // until a height is armed" provable by inspection instead of argued.
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            for(const network of ['mainnet', 'testnet', 'regtest'])
                for(const h of [0, 1, 958500, 962500, 6335000, 999999999]){
                    // Skip every ARMED chain, derived from the map rather than a
                    // hardcoded pair: with two heights armed (BTC:regtest 10000 and
                    // BTC:testnet 146500) a hardcoded skip would quietly walk over a
                    // chain that DOES query, and assert the opposite of its own name.
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

    it('the SQL shape is pinned at source: binary collation, no pre-max NULL filter', function(){
        // Comments are stripped BEFORE the quoted-string scan: prose apostrophes
        // ("repo's") otherwise open a phantom string literal and the check ends up
        // grading the documentation instead of the queries.
        const src = fs.readFileSync(path.resolve(__dirname, '../../src/contractStateSubtree.js'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const sql = src.match(/'[^']*(?:SELECT|FROM|WHERE|GROUP BY|ORDER BY)[^']*'/g).join(' ');
        // Every contract_state key reference is the utf8_bin shadow column. A plain
        // state_key would fold distinct keys under utf8_general_ci and build the SMT
        // over a folded key set: a fork the stub above cannot see. Output ALIASES
        // (`state_key_bin AS state_key`) are not column references and are stripped
        // before the check, so this pins what is read, not what it is called.
        const referenced = sql.replace(/AS state_key\b/g, '');
        assert.ok(!/\bstate_key\b(?!_bin)/.test(referenced),
            'contract_state queries must reference state_key_bin, never state_key');
        assert.ok(/GROUP BY contract_index, state_key_bin/.test(sql), 'full build must group on the binary shadow');
        assert.ok(/ORDER BY id DESC LIMIT 1/.test(sql), 'latest-row read must be by descending id');
        // The NULL test lives in JS, AFTER the max. If this ever appears in the SQL
        // it must be in an OUTER position; the safe rule is that it appears nowhere.
        assert.ok(!/state_value IS NOT NULL/.test(sql),
            'a state_value IS NOT NULL predicate must not enter these queries: applied before MAX(id) it resurrects deleted keys');
    });
});

describe('contract_state_root: key derivation @regression', function(){

    it('is domain-separated from the balance and escrow key domains', function(){
        const k = M.toHex(M.contractStateKey(CHAIN, NETWORK, 7, 'k'));
        assert.notStrictEqual(k, M.toHex(M.balanceKey(CHAIN, NETWORK, '7', 'k')));
        assert.notStrictEqual(k, M.toHex(M.escrowKey(CHAIN, NETWORK, '7', 'k')));
        assert.strictEqual(k, M.toHex(M.smtKey('XCHAIN_CST', [CHAIN, NETWORK, '7', 'k'])));
    });

    it('separates chain, network, contract and key (no field can be smeared into another)', function(){
        const base = M.toHex(M.contractStateKey('BTC', 'regtest', 7, 'k'));
        for(const other of [ M.contractStateKey('LTC', 'regtest', 7, 'k'),
                             M.contractStateKey('BTC', 'testnet', 7, 'k'),
                             M.contractStateKey('BTC', 'regtest', 8, 'k'),
                             M.contractStateKey('BTC', 'regtest', 7, 'k2'),
                             M.contractStateKey('BTC', 'regtest', 77, ''),
                             M.contractStateKey('BTC', 'regtest', 7, '7k') ])
            assert.notStrictEqual(base, M.toHex(other));
    });

    it('contract_index type does not change the key (driver bigint config is not consensus)', function(){
        // MariaDB drivers return BIGINT UNSIGNED as a number, a string or a BigInt
        // depending on options the two twins are not obliged to share. All three
        // must key identically or the follower halts on a root only it computes.
        const asNumber = M.toHex(M.contractStateKey(CHAIN, NETWORK, 7, 'k'));
        const asString = M.toHex(M.contractStateKey(CHAIN, NETWORK, '7', 'k'));
        const asBigInt = M.toHex(M.contractStateKey(CHAIN, NETWORK, 7n, 'k'));
        assert.strictEqual(asString, asNumber);
        assert.strictEqual(asBigInt, asNumber);
    });

    it('a 0x00-bearing state_key still throws, and that is the known  surface', function(){
        // The encoding route that would have made this total was closed by operator
        // decision ( repins the VM NUL rejection instead), so this throw is
        // load-bearing documentation: Stage A may not arm until those gates are
        // ARMED, because the arming block's full build reads the whole table.
        assert.throws(() => M.contractStateKey(CHAIN, NETWORK, 7, 'a\u0000b'), /0x00/);
    });
});

describe('contract_state_root: incremental equals full build @regression', function(){

    // A block's writes land BEFORE its root is computed, and no later block's
    // rows exist yet. That ordering is production's, and it is a real
    // precondition rather than a fixture convenience: latestStateValue reads the
    // newest row for a key with no as-of-height filter, so computing a
    // historical block's root while later rows exist would read the future. The
    // balances path (getNetBalance sums all credits/debits) has the identical
    // property, and every caller of both satisfies it because roots are computed
    // once, inside the block that produces them.
    async function runChain(db, schedule, from, to){
        for(let h = from; h <= to; h++){
            for(const w of (schedule[h] || [])) db.write(h, w[0], w[1], w[2]);
            db.storeRoot(h, await CST.resolveContractStateRoot(db, db.smt(), CHAIN, NETWORK, h));
        }
        return db.roots.get(to).contract_state_root;
    }

    const SCHEDULE = {
        100: [[7, 'alpha', '"a1"'], [7, 'beta', '"b1"']],
        101: [[7, 'alpha', '"a2"'],                       // overwrite
              [8, 'alpha', '"other"']],                   // same key, different contract
        102: [[7, 'beta',  null]],                        // delete
        103: [[7, 'gamma', '']],                          // the defensive empty-string case
        104: [[8, 'alpha', '"other2"']]
    };

    async function advance(db, from, to){ return runChain(db, {}, from, to); }

    it('threading block by block lands on the same root as one full build', async function(){
        const db = new FakeDb();
        db.storeRoot(99, EMPTY);                     // prior root exists, so we thread
        const threaded = await runChain(db, SCHEDULE, 100, 104);
        const full     = await CST.buildFullContractStateRoot(db, db.smt(), CHAIN, NETWORK);
        assert.strictEqual(threaded, full);
        assert.notStrictEqual(threaded, EMPTY, 'the fixture must actually populate a tree');
    });

    it('a block that deletes the last live key returns the tree to EMPTY', async function(){
        const db = new FakeDb();
        db.write(100, 7, 'only', '"v"');
        db.storeRoot(99, EMPTY);
        const at100 = await advance(db, 100, 100);
        assert.notStrictEqual(at100, EMPTY);
        db.write(101, 7, 'only', null);
        const at101 = await advance(db, 101, 101);
        assert.strictEqual(at101, EMPTY, 'delete-on-tombstone must collapse back to the empty root');
    });

    it('a block touching nothing leaves the root unchanged', async function(){
        const db = new FakeDb();
        db.write(100, 7, 'k', '"v"');
        db.storeRoot(99, EMPTY);
        const at100 = await advance(db, 100, 100);
        const at101 = await advance(db, 101, 101);
        assert.strictEqual(at101, at100);
    });

    it('no prior root full-builds instead of threading from EMPTY (the silent-fork refusal)', async function(){
        // Snapshot bootstrap: the tables are fully populated but there is no
        // block-1 row. Threading from EMPTY would commit a root forked from a
        // from-genesis node; the full build is the same root that node has.
        const db = new FakeDb();
        await runChain(db, SCHEDULE, 100, 104);
        db.roots.clear();                            // snapshot copies tables, not root history
        const seeded = await CST.resolveContractStateRoot(db, db.smt(), CHAIN, NETWORK, 105);
        const full   = await CST.buildFullContractStateRoot(db, db.smt(), CHAIN, NETWORK);
        assert.strictEqual(seeded, full);
        assert.notStrictEqual(seeded, EMPTY);
    });

    it('key insertion order does not change the root (the SMT is key-addressed)', async function(){
        const a = new FakeDb(), b = new FakeDb();
        a.write(1, 7, 'k1', '"v1"'); a.write(1, 7, 'k2', '"v2"'); a.write(1, 9, 'k3', '"v3"');
        b.write(1, 9, 'k3', '"v3"'); b.write(1, 7, 'k2', '"v2"'); b.write(1, 7, 'k1', '"v1"');
        assert.strictEqual(await CST.buildFullContractStateRoot(a, a.smt(), CHAIN, NETWORK),
                           await CST.buildFullContractStateRoot(b, b.smt(), CHAIN, NETWORK));
    });
});

describe('contract_state_root: shadow-compute window @regression', function(){

    const SHADOW_FROM = 300, ARMED = 400;

    // `await fn()`, not `return fn()`: without the await the finally below runs the
    // instant fn returns its promise, so the maps are torn down before the async
    // body reads them and every assertion silently runs against an inert gate.
    async function shadowFrom(height, armedAt, fn){
        const sMap = SUB.STATE_SUBTREE_SHADOW.contract_state_root;
        const aMap = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root;
        const k = CHAIN + ':' + NETWORK;
        // RESTORE, never delete: contract_state_root now carries a REAL armed
        // height, and deleting it here disarms the chain for every later test.
        const hadA = Object.prototype.hasOwnProperty.call(aMap, k), prevA = aMap[k];
        const hadS = Object.prototype.hasOwnProperty.call(sMap, k), prevS = sMap[k];
        sMap[k] = height;
        if(armedAt != null) aMap[k] = armedAt;
        try { return await fn(); } finally {
            if(hadS) sMap[k] = prevS; else delete sMap[k];
            if(hadA) aMap[k] = prevA; else delete aMap[k];
        }
    }

    it('ships inert: nothing shadows on any chain, network or height', function(){
        for(const slot of SUB.RESERVED_SUBTREES){
            assert.deepStrictEqual(Object.keys(SUB.STATE_SUBTREE_SHADOW[slot]), [], 'slot ' + slot);
            for(const coin of ['BTC', 'LTC', 'DOGE'])
                for(const h of [0, 962500, 999999999])
                    assert.strictEqual(SUB.isSubtreeShadowActive(slot, h, 'mainnet', coin), false);
        }
    });

    it('ARMED WINS: a height that is both shadowing and armed shadows nothing', async function(){
        // Otherwise the same block derives twice and writes both columns, and the
        // shadow column silently becomes a second opinion about committed state.
        await shadowFrom(SHADOW_FROM, ARMED, async () => {
            assert.strictEqual(SUB.isSubtreeShadowActive('contract_state_root', ARMED, NETWORK, CHAIN), false);
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', ARMED, NETWORK, CHAIN), true);
            // ...and below the armed height it is the other way round.
            assert.strictEqual(SUB.isSubtreeShadowActive('contract_state_root', ARMED - 1, NETWORK, CHAIN), true);
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', ARMED - 1, NETWORK, CHAIN), false);
        });
    });

    it('a shadow value NEVER reaches state_root', async function(){
        // The whole safety case in one assertion: while only shadowing, the
        // committed assembly must stay byte-identical to the v1 two-root form.
        await shadowFrom(SHADOW_FROM, null, async () => {
            const db = new FakeDb();
            db.write(SHADOW_FROM, 7, 'k', '"v"');
            const candidates = await SC.reservedSubRootCandidates(db, CHAIN, NETWORK, SHADOW_FROM);
            assert.strictEqual(candidates, null, 'a shadowing chain offers NO committed candidate');
            const gated = SUB.gateSubRoots(candidates, SHADOW_FROM, NETWORK, CHAIN);
            assert.strictEqual(gated, null);
            assert.strictEqual(SC.extraSubRootColumn(gated, 'contract_state_root'), null,
                'and therefore writes NULL to the committed column');
        });
    });

    it('the shadow derives a real root and threads through its OWN column', async function(){
        await shadowFrom(SHADOW_FROM, null, async () => {
            const db = new FakeDb();
            db.write(SHADOW_FROM, 7, 'a', '"1"');
            const first = SC.extraSubRootColumn(
                await SC.shadowSubRoots(db, CHAIN, NETWORK, SHADOW_FROM), 'contract_state_root');
            assert.ok(first && first !== EMPTY, 'the shadow must produce a real root');
            db.storeShadow(SHADOW_FROM, first);

            // Next block threads from the SHADOW column, not the committed one
            // (which is NULL here, and would force a full build every block).
            db.write(SHADOW_FROM + 1, 7, 'b', '"2"');
            const second = SC.extraSubRootColumn(
                await SC.shadowSubRoots(db, CHAIN, NETWORK, SHADOW_FROM + 1), 'contract_state_root');
            const full = await CST.buildFullContractStateRoot(db, db.smt(), CHAIN, NETWORK);
            assert.strictEqual(second, full, 'threaded shadow must equal a full build of the same state');
            assert.notStrictEqual(second, first);
        });
    });

    it('the arming block full-builds and does NOT inherit the shadow value', async function(){
        // Determinism at the boundary: a node that never shadowed and a node that
        // did must commit the same root, so the committed path may not depend on
        // whether a shadow run happened to be configured.
        await shadowFrom(SHADOW_FROM, ARMED, async () => {
            const shadowed = new FakeDb(), fresh = new FakeDb();
            for(const db of [shadowed, fresh]) db.write(ARMED - 1, 7, 'k', '"v"');
            shadowed.storeShadow(ARMED - 1, 'ff'.repeat(32));   // a deliberately WRONG shadow value

            const a = SC.extraSubRootColumn(
                SUB.gateSubRoots(await SC.reservedSubRootCandidates(shadowed, CHAIN, NETWORK, ARMED),
                                 ARMED, NETWORK, CHAIN), 'contract_state_root');
            const b = SC.extraSubRootColumn(
                SUB.gateSubRoots(await SC.reservedSubRootCandidates(fresh, CHAIN, NETWORK, ARMED),
                                 ARMED, NETWORK, CHAIN), 'contract_state_root');
            assert.strictEqual(a, b, 'a bad shadow value must not be able to poison the committed root');
            assert.strictEqual(a, await CST.buildFullContractStateRoot(fresh, fresh.smt(), CHAIN, NETWORK));
        });
    });
});

describe('contract_state_root: arming boundary and reorg @regression', function(){

    const ARMED = 500;

    // One block through the real gated path, returning what the row would store.
    async function blockRow(db, height){
        const candidates    = await SC.reservedSubRootCandidates(db, CHAIN, NETWORK, height);
        const extraSubRoots = SUB.gateSubRoots(candidates, height, NETWORK, CHAIN);
        const column        = SC.extraSubRootColumn(extraSubRoots, 'contract_state_root');
        db.storeRoot(height, column);
        return { column, state_root: SC.assembleStateRoot(rootHex('bal'), rootHex('stk'), extraSubRoots) };
    }
    function rootHex(tag){ return M.toHex(M.sha256(Buffer.from(tag, 'utf8'))); }
    const V1_STATE_ROOT = SC.assembleStateRoot(rootHex('bal'), rootHex('stk'), null);

    it('below the armed height the slot is EMPTY and state_root is byte-identical to v1', async function(){
        await armedAt(ARMED, async () => {
            const db = new FakeDb();
            db.write(ARMED - 1, 7, 'k', '"v"');
            const row = await blockRow(db, ARMED - 1);
            assert.strictEqual(row.column, null);
            assert.strictEqual(row.state_root, V1_STATE_ROOT);
        });
    });

    it('the arming block full-builds (its predecessor stored NULL) and moves state_root', async function(){
        await armedAt(ARMED, async () => {
            const db = new FakeDb();
            db.write(ARMED - 1, 7, 'k', '"v"');      // written BELOW the height: must still be committed
            await blockRow(db, ARMED - 1);
            const row = await blockRow(db, ARMED);
            const full = await CST.buildFullContractStateRoot(db, db.smt(), CHAIN, NETWORK);
            assert.strictEqual(row.column, full, 'the arming block must commit the whole live key set');
            assert.notStrictEqual(row.column, EMPTY);
            assert.notStrictEqual(row.state_root, V1_STATE_ROOT);
        });
    });

    it('a reorg back below the armed height recommits EMPTY and restores the exact v1 state_root', async function(){
        await armedAt(ARMED, async () => {
            const db = new FakeDb();
            db.write(ARMED - 1, 7, 'k', '"v"');
            await blockRow(db, ARMED - 1);
            const armedRow = await blockRow(db, ARMED);
            db.write(ARMED, 7, 'k2', '"v2"');
            const armedRow2 = await blockRow(db, ARMED);   // recompute with the block's own write

            // Reorg: rows and root rows >= ARMED are deleted, the chain re-advances.
            db.rollbackTo(ARMED);
            const back = await blockRow(db, ARMED - 1);
            assert.strictEqual(back.column, null, 'below the height the slot must be EMPTY again');
            assert.strictEqual(back.state_root, V1_STATE_ROOT, 'and state_root must be the v1 bytes exactly');

            // Re-advance across the boundary with the same content: same roots.
            const again = await blockRow(db, ARMED);
            assert.strictEqual(again.column, armedRow.column, 're-crossing the boundary must be deterministic');
            assert.notStrictEqual(armedRow2.column, armedRow.column, 'and the fixture must really differ per content');
        });
    });

    it('an orphaned write reverts without any rollback-repair pass', async function(){
        // The claim the whole no-touched-set design rests on: because the next
        // block threads from the SURVIVING row's stored root, a key written only
        // by an orphaned block is gone with no "keys to undo" derivation anywhere.
        await armedAt(ARMED, async () => {
            const db = new FakeDb();
            db.write(ARMED, 7, 'keep', '"k"');
            await blockRow(db, ARMED - 1);
            const atArmed = await blockRow(db, ARMED);

            db.write(ARMED + 1, 7, 'orphan', '"o"');
            const withOrphan = await blockRow(db, ARMED + 1);
            assert.notStrictEqual(withOrphan.column, atArmed.column);

            db.rollbackTo(ARMED + 1);                       // the orphan block is gone
            const replacement = await blockRow(db, ARMED + 1);
            assert.strictEqual(replacement.column, atArmed.column,
                'the orphaned key must be absent again, purely from threading the surviving root');
        });
    });

    it('a snapshot bootstrap at an armed height agrees with a from-genesis node', async function(){
        await armedAt(ARMED, async () => {
            // From-genesis node: full-builds at the arming block, then THREADS
            // for three more blocks. If it only full-built, this vector would
            // compare two full builds and prove nothing about the seam.
            const writes = {
                [ARMED - 1]: [[7, 'below', '"b"']],       // written before arming, still committed
                [ARMED]:     [[7, 'a', '"1"']],
                [ARMED + 1]: [[7, 'b', '"2"'], [9, 'a', '"9"']],
                [ARMED + 2]: [[7, 'a', '"1b"'], [7, 'b', null]],
                [ARMED + 3]: [[9, 'a', '']]
            };
            const live = new FakeDb();
            for(let h = ARMED - 1; h <= ARMED + 3; h++){
                for(const w of (writes[h] || [])) live.write(h, w[0], w[1], w[2]);
                await blockRow(live, h);
            }
            const threaded = live.roots.get(ARMED + 3).contract_state_root;
            assert.ok(threaded && threaded !== EMPTY, 'the live chain must hold a populated tree');

            // Bootstrapped node: identical tables, no root history at all.
            const seeded = new FakeDb();
            for(const r of live.rows) seeded.write(r.block_index, r.contract_index, r.state_key, r.state_value);
            const seededRow = await blockRow(seeded, ARMED + 3);

            assert.strictEqual(seededRow.column, threaded,
                'a follower seeded from a snapshot must commit the same slot as a node that threaded to it');
            assert.notStrictEqual(seededRow.state_root, V1_STATE_ROOT,
                'and both are above the arming height, so neither is still on the v1 assembly');
        });
    });
});

// ---------------------------------------------------------------------------
// M-17: the derivation reads STRICTLY, so a DB fault halts instead of forking.
//
// doQuery collapses a NON-transactional query error into [], and an empty
// result is a meaningful answer at every read here, not an error signal. These
// vectors pin both halves: that no read uses the soft reader, and that when a
// read does fault, the derivation refuses to produce a root at all. The second
// half is the one that matters, because a future edit could reintroduce
// doQuery and only the fault injection would notice.
// ---------------------------------------------------------------------------
describe('contract_state_root: strict reads @regression', function(){

    const ARMED = 500;

    it('every derivation read goes through doQueryStrict, never doQuery', async function(){
        await armedAt(ARMED, async () => {
            const db = new FakeDb();
            db.write(ARMED - 1, 7, 'below', '"b"');
            db.write(ARMED, 7, 'a', '"1"');
            // Full build (arming block) and then the incremental thread, so both
            // code paths' reads are observed rather than just one.
            const c0 = await SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED);
            db.storeRoot(ARMED, SUB.gateSubRoots(c0, ARMED, NETWORK, CHAIN).contract_state_root);
            db.write(ARMED + 1, 7, 'a', '"2"');
            await SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED + 1);

            const soft = db.softSql.filter(s => s.indexOf('contract_state') !== -1
                                             || s.indexOf('state_tree_roots') !== -1);
            assert.deepStrictEqual(soft, [],
                'the derivation must not read contract_state or state_tree_roots through doQuery');
            assert.ok(db.strictSql.some(s => s.indexOf('FROM contract_state') !== -1),
                'and it must actually have read contract_state (a no-op cannot pass vacuously)');
            assert.ok(db.strictSql.some(s => s.indexOf('FROM state_tree_roots') !== -1),
                'including the prior-root read');
        });
    });

    it('a faulting touched-key read THROWS rather than threading the block forward unchanged', async function(){
        await armedAt(ARMED, async () => {
            const db = new FakeDb();
            db.write(ARMED, 7, 'a', '"1"');
            const c0 = await SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED);
            const armedRoot = SUB.gateSubRoots(c0, ARMED, NETWORK, CHAIN).contract_state_root;
            db.storeRoot(ARMED, armedRoot);

            // Block ARMED+1 changes the key. Under doQuery the DISTINCT read
            // would return [] and this block would commit `armedRoot` unchanged:
            // a silent fork against every node that applied the write.
            db.write(ARMED + 1, 7, 'a', '"2"');
            db.failOn = 'SELECT DISTINCT';
            await assert.rejects(
                () => SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED + 1),
                /injected DB fault/,
                'a faulting touched-key read must halt the block, not commit the prior root');

            // And with the fault cleared the same block moves the root, which is
            // what proves the assertion above was about the fault and not about
            // an empty block.
            db.failOn = null;
            const c1 = await SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED + 1);
            assert.notStrictEqual(SUB.gateSubRoots(c1, ARMED + 1, NETWORK, CHAIN).contract_state_root,
                armedRoot, 'the block really did change the tree');
        });
    });

    it('a faulting full build THROWS rather than committing EMPTY over a populated table', async function(){
        await armedAt(ARMED, async () => {
            const db = new FakeDb();
            db.write(ARMED - 1, 7, 'k', '"v"');
            db.failOn = 'INNER JOIN';                  // the MAX(id) full-build join
            await assert.rejects(
                () => SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED),
                /injected DB fault/,
                'the arming block must not commit EMPTY because its own read failed');
        });
    });

    it('a faulting latest-value read THROWS rather than DELETING the key from the tree', async function(){
        await armedAt(ARMED, async () => {
            const db = new FakeDb();
            db.write(ARMED, 7, 'a', '"1"');
            const c0 = await SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED);
            db.storeRoot(ARMED, SUB.gateSubRoots(c0, ARMED, NETWORK, CHAIN).contract_state_root);
            db.write(ARMED + 1, 7, 'a', '"2"');
            db.failOn = 'ORDER BY id DESC LIMIT 1';    // the per-key winning-row read
            await assert.rejects(
                () => SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED + 1),
                /injected DB fault/,
                'an empty winning-row read is the tombstone mapping, so it must never come from a fault');
        });
    });
});

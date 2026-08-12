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
 * XCHAIN_ESC locked-balance leaf conformance (SPV sub-tree spec §3 Stage B,
 * stage B1).
 *
 * The load-bearing assertion is INERTNESS, and it matters more here than it did
 * for Stage A. Stage A lit a top-level slot that was EMPTY on every chain, so a
 * mistake there could only change a value nobody was committing. This leaf lives
 * inside balances_root, the one sub-root every deployed light client already
 * depends on, so any leakage below an armed height changes a root the whole fleet
 * is already comparing every block. The vectors below pin that the escrow leaf is
 * not merely gated but NOT REACHED while inert, on every chain and height.
 *
 * DELETE-ON-ZERO is the second focus, and it is BROADER than Stage A's tombstone
 * rule: a locked total legitimately reaches zero when an order fully fills, so
 * NULL and canonical zero must be the same answer (no leaf). Committing
 * leafHash(canonicalAmount('0')) instead forks the twins on the first fully
 * filled order, which is why the parent spec makes delete-on-zero normative.
 *
 * TWIN PAIR: kept BYTE-IDENTICAL with xchain-sync/test/unit/escrowLeafSubtree.test.js
 * and locked equal by the cross-repo loop in rollback-coverage.test.js.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const M   = require('../../src/merkle.js');
const SC  = require('../../src/stateCommitment.js');
const SUB = require('../../src/state_subtree_activation.js');
const ESC = require('../../src/escrowLeafSubtree.js');

const CHAIN = 'BTC', NETWORK = 'regtest';
const ADDR  = '1LockerAaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TICK  = 'XCHAIN';

// Fake db over the journal + the two index tables it joins. Rows are appended
// exactly as the source appends them: one per key whose total CHANGED in a block.
class FakeDb {
    constructor(){
        this.rows = []; this.nodes = new Map(); this.nextId = 1; this.journalQueries = 0;
        // M-17: which reader each SQL string arrived through, plus fault injection.
        // Every journal read must be strict, because doQuery turns a
        // non-transactional fault into [], and [] is delete-on-zero here.
        this.softSql   = [];
        this.strictSql = [];
        this.failOn    = null;
    }
    write(blockIndex, address, tick, lockedAmount){
        this.rows.push({ id: this.nextId++, address: address, tick: tick,
                         locked_amount: lockedAmount, block_index: blockIndex });
    }
    rollbackTo(height){ this.rows = this.rows.filter(r => r.block_index < height); }
    smt(){
        const self = this;
        return new SC.PersistentSMT({
            async get(h){ return self.nodes.has(h) ? self.nodes.get(h) : null; },
            async put(h, l, r){ if(!self.nodes.has(h)) self.nodes.set(h, { left_hash: l, right_hash: r }); }
        });
    }
    // Two readers, deliberately not one method: the balances path around this
    // module legitimately uses doQuery, so recording which reader each SQL
    // string came through is what proves the journal reads went strict.
    async doQuery(sql, args){
        this.softSql.push(sql);
        return await this._run(sql, args);
    }
    async doQueryStrict(sql, args){
        this.strictSql.push(sql);
        return await this._run(sql, args);
    }
    async _run(sql, args){
        if(this.failOn && sql.indexOf(this.failOn) !== -1)
            throw new Error('injected DB fault');
        if(sql.indexOf('escrow_leaf_journal') === -1) throw new Error('unexpected query: ' + sql.slice(0, 60));
        this.journalQueries++;
        if(sql.indexOf('SELECT DISTINCT') === 0){
            const seen = new Map();
            for(const r of this.rows)
                if(r.block_index === args[0])
                    seen.set(r.address + '' + r.tick, { address: r.address, tick: r.tick });
            return Array.from(seen.values());
        }
        if(sql.indexOf('ORDER BY j.id DESC LIMIT 1') !== -1){
            const bounded = (args.length === 3);
            let best = null;
            for(const r of this.rows){
                if(r.address !== args[0] || r.tick !== args[1]) continue;
                if(bounded && r.block_index > args[2]) continue;
                if(!best || r.id > best.id) best = r;
            }
            return best ? [{ locked_amount: best.locked_amount }] : [];
        }
        // Live set: MAX(id) per key, tombstones NOT filtered in SQL.
        const max = new Map();
        for(const r of this.rows){
            const k = r.address + '' + r.tick;
            const cur = max.get(k);
            if(!cur || r.id > cur.id) max.set(k, r);
        }
        return Array.from(max.values()).map(r => ({ address: r.address, tick: r.tick,
                                                    locked_amount: r.locked_amount }));
    }
}

async function armed(height, fn){
    const map = SUB.ESCROW_LOCKED_LEAF_ACTIVATION;
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

describe('XCHAIN_ESC locked leaf: inertness @regression', function(){

    it('is inert on every chain, network and height EXCEPT the armed one', function(){
        // Was "ships inert everywhere", correct while the map was empty and replaced
        // rather than deleted the moment BTC:regtest armed. The mainnet half is the
        // assertion that must never be relaxed.
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_ACTIVATION, { 'BTC:regtest': 11200 });
        for(const key of Object.keys(SUB.ESCROW_LOCKED_LEAF_ACTIVATION))
            assert.ok(!/mainnet/.test(key), 'the escrow leaf is armed on mainnet (' + key + ')');
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            for(const network of ['mainnet', 'testnet', 'regtest'])
                for(const h of [0, 1, 958500, 962500, 6335000, 999999999]){
                    const armed = (coin === 'BTC' && network === 'regtest' && h >= 11200);
                    assert.strictEqual(SUB.isEscrowLockedLeafActive(h, network, coin), armed,
                        coin + '/' + network + '@' + h);
                }
    });

    it('an inert chain issues ZERO journal queries from the full rebuild', async function(){
        // balances_root must keep its exact v1 leaf set below an armed height, and
        // the cheapest proof of that is that the journal is never even read.
        const db = new FakeDb();
        db.write(100, ADDR, TICK, '5');
        // BOTH readers are counted. The journal read is strict (M-17) while the
        // credits/debits reads around it are not, so stubbing only doQuery would
        // make this pass by missing the very query it is counting.
        const count = async (sql) => {
            if(sql.indexOf('escrow_leaf_journal') !== -1){ db.journalQueries++; return []; }
            return [];                           // no credits/debits either
        };
        // BELOW the armed height, which is where "inert" now lives on this chain: the
        // height used to be 999999999, which arming BTC:regtest at 11200 turned into an
        // ARMED height, so the test was asserting the opposite of its own name.
        const root = await SC.buildFullBalancesRoot(
            Object.assign(db, { doQuery: count, doQueryStrict: count }),
            CHAIN, NETWORK, 11199);
        assert.strictEqual(db.journalQueries, 0, 'inert chain must not read the journal');
        assert.strictEqual(root, SC.EMPTY_ROOT_HEX);
    });

    it('the ARMED height DOES read the journal (the gate really opened)', async function(){
        // The other half of the property above. Counting zero reads proves nothing about
        // the gate unless the armed side is shown to read, which is the same
        // positive-complement rule the Stage A arming had to learn.
        const db = new FakeDb();
        db.write(100, ADDR, TICK, '5');
        let journalQueries = 0;
        const count = async (sql) => {
            if(sql.indexOf('escrow_leaf_journal') !== -1){ journalQueries++; return []; }
            return [];
        };
        await SC.buildFullBalancesRoot(
            Object.assign(db, { doQuery: count, doQueryStrict: count }),
            CHAIN, NETWORK, 11200);
        assert.ok(journalQueries > 0, 'armed chain must read the journal at the armed height');
    });

    it('a full rebuild with NO height argument keeps the v1 leaf set (fail closed)', async function(){
        // The height is a new parameter; an un-updated caller must degrade to v1
        // rather than to "arm everywhere".
        const db = new FakeDb();
        const count = async (sql) => { if(sql.indexOf('escrow_leaf_journal') !== -1){ db.journalQueries++; } return []; };
        db.doQuery = count; db.doQueryStrict = count;
        await SC.buildFullBalancesRoot(db, CHAIN, NETWORK);
        assert.strictEqual(db.journalQueries, 0);
    });
});

describe('XCHAIN_ESC locked leaf: delete-on-zero @regression', function(){

    it('NULL, empty and canonical zero are all "no leaf"', function(){
        assert.strictEqual(ESC.escrowLeaf(null), null);
        assert.strictEqual(ESC.escrowLeaf(undefined), null);
        assert.strictEqual(ESC.escrowLeaf(''), null);
        assert.strictEqual(ESC.escrowLeaf('0'), null);
        assert.strictEqual(ESC.escrowLeaf('0.000000000000000000'), null);
    });

    it('a nonzero total is amountLeaf, the same encoding the spendable leaf uses', function(){
        assert.strictEqual(ESC.escrowLeaf('5'), M.toHex(M.amountLeaf('5')));
        // Same amount, different key domain: a client verifies both leaves the same
        // way, and XCHAIN_BAL absence proofs are unaffected by XCHAIN_ESC keys.
        assert.notStrictEqual(M.toHex(M.escrowKey(CHAIN, NETWORK, ADDR, TICK)),
                              M.toHex(M.balanceKey(CHAIN, NETWORK, ADDR, TICK)));
    });

    it('a fully filled order returns the tree to its pre-lock root', async function(){
        // THE delete-on-zero vector. If zero committed a leaf instead of deleting,
        // the twins would fork on the first fully filled order.
        const db = new FakeDb();
        const smt = db.smt();
        const before = SC.EMPTY_ROOT_HEX;
        db.write(100, ADDR, TICK, '5');
        const locked = await ESC.applyEscrowLeaves(db, smt, before, CHAIN, NETWORK, 100);
        assert.notStrictEqual(locked, before);
        db.write(101, ADDR, TICK, '0');
        const released = await ESC.applyEscrowLeaves(db, smt, locked, CHAIN, NETWORK, 101);
        assert.strictEqual(released, before, 'zero must DELETE the leaf, not commit leafHash("0")');
    });

    it('a negative total throws rather than committing (writer bug, not a state)', function(){
        // It would mean the writer released more than was locked, which is exactly
        // what the reconciliation invariant exists to catch. Halting beats committing.
        assert.throws(() => ESC.escrowLeaf('-1'), /non-canonical amount/);
    });
});

describe('XCHAIN_ESC locked leaf: journal reads @regression', function(){

    it('MAX(id) runs over releases too: a released lock stays released', async function(){
        const db = new FakeDb();
        db.write(100, ADDR, TICK, '5');
        db.write(101, ADDR, TICK, '9');
        db.write(102, ADDR, TICK, null);
        assert.strictEqual(await ESC.latestLockedAmount(db, ADDR, TICK), null);
        assert.deepStrictEqual(await ESC.liveEscrowLeaves(db), []);
    });

    it('as-of-height reads serve the value the checkpoint committed', async function(){
        // The requirement mutable order rows could not meet: a proof for a historical
        // checkpoint must not be served the tip value.
        const db = new FakeDb();
        db.write(100, ADDR, TICK, '5');
        db.write(150, ADDR, TICK, '2');
        assert.strictEqual(await ESC.latestLockedAmount(db, ADDR, TICK, 100), '5');
        assert.strictEqual(await ESC.latestLockedAmount(db, ADDR, TICK, 149), '5');
        assert.strictEqual(await ESC.latestLockedAmount(db, ADDR, TICK, 150), '2');
        assert.strictEqual(await ESC.latestLockedAmount(db, ADDR, TICK), '2');
    });

    it('the touched set is per LOCKER, and only for blocks that changed a total', async function(){
        const db = new FakeDb();
        db.write(100, ADDR, TICK, '5');
        assert.deepStrictEqual(await ESC.touchedEscrowKeys(db, 100), [{ address: ADDR, tick: TICK }]);
        assert.deepStrictEqual(await ESC.touchedEscrowKeys(db, 101), [],
            'a block that changed no locked total touches nothing');
    });

    it('an orphaned journal row reverts with no repair pass', async function(){
        // Same structural property Stage A proved: rows >= the orphan height are
        // deleted with the roots rows, so the next block threads from a root that
        // never contained the orphaned value.
        const db = new FakeDb();
        const smt = db.smt();
        db.write(100, ADDR, TICK, '5');
        const at100 = await ESC.applyEscrowLeaves(db, smt, SC.EMPTY_ROOT_HEX, CHAIN, NETWORK, 100);
        db.write(101, ADDR, TICK, '7');
        const at101 = await ESC.applyEscrowLeaves(db, smt, at100, CHAIN, NETWORK, 101);
        assert.notStrictEqual(at101, at100);
        db.rollbackTo(101);
        const replay = await ESC.applyEscrowLeaves(db, smt, at100, CHAIN, NETWORK, 101);
        assert.strictEqual(replay, at100);
    });

    it('incremental application equals a full rebuild of the same live set', async function(){
        const db = new FakeDb();
        const other = '1LockerBbbbbbbbbbbbbbbbbbbbbbbbbbb';
        let root = SC.EMPTY_ROOT_HEX;
        const smt = db.smt();
        const schedule = { 100: [[ADDR, TICK, '5']], 101: [[other, TICK, '3']],
                           102: [[ADDR, TICK, '8']], 103: [[other, TICK, '0']] };
        for(let h = 100; h <= 103; h++){
            for(const w of (schedule[h] || [])) db.write(h, w[0], w[1], w[2]);
            root = await ESC.applyEscrowLeaves(db, smt, root, CHAIN, NETWORK, h);
        }
        let full = SC.EMPTY_ROOT_HEX;
        const smt2 = db.smt();
        for(const e of await ESC.liveEscrowLeaves(db))
            full = await smt2.update(full, M.escrowKey(CHAIN, NETWORK, e.address, e.tick), e.leaf);
        assert.strictEqual(root, full);
        assert.notStrictEqual(root, SC.EMPTY_ROOT_HEX);
    });
});

describe('XCHAIN_ESC locked leaf: arming moves balances_root @regression', function(){

    it('an armed height adds locked leaves the inert height does not have', async function(){
        const db = new FakeDb();
        db.write(500, ADDR, TICK, '5');
        const smt = db.smt();
        const inert = await ESC.applyEscrowLeaves(db, smt, SC.EMPTY_ROOT_HEX, CHAIN, NETWORK, 500);
        assert.notStrictEqual(inert, SC.EMPTY_ROOT_HEX, 'the derivation itself is not a no-op');
        // The gate is what keeps it out of balances_root while inert; prove it opens.
        await armed(500, async () => {
            assert.strictEqual(SUB.isEscrowLockedLeafActive(500, NETWORK, CHAIN), true);
            assert.strictEqual(SUB.isEscrowLockedLeafActive(499, NETWORK, CHAIN), false);
            // Arming the escrow leaf flips the derived version, exactly as a slot does.
            assert.strictEqual(SUB.stateRootVersion(500, NETWORK, CHAIN), 2);
            assert.strictEqual(SUB.stateRootVersion(499, NETWORK, CHAIN), 1);
        });
    });
});

describe('XCHAIN_ESC locked leaf: the §7 shadow thread @regression', function(){

    // resolveShadowBalancesRoot computes the WOULD-BE balances_root below the
    // armed height, threading through its own column. The caller supplies this
    // block's spendable updates (derived with its committed-path mechanism) and
    // a full-build fallback with escrow leaves forced on; this suite pins the
    // three-way contract between them.

    // FakeDb serves only journal queries; give the shadow thread its prior-row
    // read on top.
    function shadowDb(priors){
        const db = new FakeDb();
        // Patch _run, not doQuery: the module reads strictly now (M-17), and
        // overriding the soft reader would leave the shadow prior-row read
        // unstubbed while quietly passing.
        const orig = db._run.bind(db);
        db._run = async function(sql, args){
            if(sql.indexOf('balances_root_escrow_shadow') !== -1){
                const r = priors[args[2]];
                return r ? [{ r }] : [];
            }
            return orig(sql, args);
        };
        return db;
    }
    const balKey  = (addr) => M.balanceKey(CHAIN, NETWORK, addr, TICK);
    const balLeaf = (amt)  => M.toHex(M.leafHash(M.canonicalAmount(amt)));

    it('no prior shadow root: full-builds through the caller callback (window start)', async function(){
        const db = shadowDb({});
        let calls = 0;
        const out = await ESC.resolveShadowBalancesRoot(db, db.smt(), CHAIN, NETWORK, 500, [],
            async () => { calls++; return 'sentinel-root'; });
        assert.strictEqual(out, 'sentinel-root');
        assert.strictEqual(calls, 1);
    });

    it('null balanceUpdates (committed path full-recomputed) forces the shadow full build too', async function(){
        const db = shadowDb({ 499: 'aa'.repeat(32) });   // prior EXISTS, updates do not
        let calls = 0;
        await ESC.resolveShadowBalancesRoot(db, db.smt(), CHAIN, NETWORK, 500, null,
            async () => { calls++; return 'sentinel-root'; });
        assert.strictEqual(calls, 1, 'threading without the per-key list would silently drop this block\'s spendable moves');
    });

    it('threading equals a fresh build of the same leaf set (spendable + locked)', async function(){
        // Block 499 state: ADDR spendable 9, locked 5. Block 500: ADDR2 gains a
        // spendable leaf and ADDR's lock steps to 7.
        const ADDR2 = '1OtherBbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const db = new FakeDb();
        db.write(499, ADDR, TICK, M.canonicalAmount('5'));
        const smt = db.smt();
        let prior = SC.EMPTY_ROOT_HEX;
        prior = await smt.update(prior, balKey(ADDR), balLeaf('9'));
        prior = await ESC.applyEscrowLeaves(db, smt, prior, CHAIN, NETWORK, 499);

        const priors = {}; priors[499] = prior;
        // Patch _run, not doQuery: the module reads strictly now (M-17), and
        // overriding the soft reader would leave the shadow prior-row read
        // unstubbed while quietly passing.
        const orig = db._run.bind(db);
        db._run = async function(sql, args){
            if(sql.indexOf('balances_root_escrow_shadow') !== -1){
                const r = priors[args[2]];
                return r ? [{ r }] : [];
            }
            return orig(sql, args);
        };
        db.write(500, ADDR, TICK, M.canonicalAmount('7'));
        const threaded = await ESC.resolveShadowBalancesRoot(db, smt, CHAIN, NETWORK, 500,
            [{ key: balKey(ADDR2), leaf: balLeaf('3') }],
            async () => { throw new Error('must thread, not full-build'); });

        // The same final state built directly: both spendable leaves + the
        // stepped lock.
        const db2 = new FakeDb();
        db2.write(500, ADDR, TICK, M.canonicalAmount('7'));
        const smt2 = db2.smt();
        let expect = SC.EMPTY_ROOT_HEX;
        expect = await smt2.update(expect, balKey(ADDR), balLeaf('9'));
        expect = await smt2.update(expect, balKey(ADDR2), balLeaf('3'));
        expect = await ESC.applyEscrowLeaves(db2, smt2, expect, CHAIN, NETWORK, 500);
        assert.strictEqual(threaded, expect);
    });

    it('the shadow value never reaches a committed column (source pin, both twins)', function(){
        // The whole safety argument of the window is one-directional data flow:
        // balancesEscrowShadow is written to its own column and nowhere else.
        const fs = require('fs'), path = require('path');
        for(const p of ['../../src/stateCommitment.js', '../../../xchain-sync/src/stateCommitment.js']){
            let src;
            try { src = fs.readFileSync(path.resolve(__dirname, p), 'utf8'); }
            catch(e){ continue; }                       // standalone checkout
            // The only consumer of the resolved shadow value is the INSERT's
            // shadow column; it must never feed assembleStateRoot or the
            // committed balances root variable.
            assert.ok(!/assembleStateRoot\([^)]*balancesEscrowShadow/.test(src),
                p + ': shadow value must never reach assembleStateRoot');
            assert.ok(!/balancesRoot\s*=\s*.*balancesEscrowShadow/.test(src),
                p + ': shadow value must never become the committed balances root');
        }
    });
});

// ---------------------------------------------------------------------------
// M-17: the journal reads STRICTLY, so a DB fault halts instead of forking.
//
// Delete-on-zero makes this stage's exposure worse than Stage A's: doQuery's
// fail-soft [] is not merely "no data", it is the exact encoding of "nothing is
// locked here", so a transient fault silently REMOVES locked leaves from
// balances_root rather than failing to add them.
// ---------------------------------------------------------------------------
describe('XCHAIN_ESC locked leaf: strict reads @regression', function(){

    it('every journal read goes through doQueryStrict, never doQuery', async function(){
        const db = new FakeDb();
        db.write(500, ADDR, TICK, M.canonicalAmount('5'));
        await ESC.applyEscrowLeaves(db, db.smt(), SC.EMPTY_ROOT_HEX, CHAIN, NETWORK, 500);
        await ESC.liveEscrowLeaves(db);
        await ESC.latestLockedAmount(db, ADDR, TICK, 500);

        assert.deepStrictEqual(db.softSql.filter(s => s.indexOf('escrow_leaf_journal') !== -1), [],
            'no journal read may use the fail-soft reader');
        assert.ok(db.strictSql.length >= 3, 'and the reads really happened');
    });

    it('a faulting touched-key read THROWS rather than leaving the locked leaves stale', async function(){
        const db = new FakeDb();
        db.write(500, ADDR, TICK, M.canonicalAmount('5'));
        db.failOn = 'SELECT DISTINCT';
        await assert.rejects(
            () => ESC.applyEscrowLeaves(db, db.smt(), SC.EMPTY_ROOT_HEX, CHAIN, NETWORK, 500),
            /injected DB fault/,
            'an empty touched set means "no locker moved", which must never come from a fault');
    });

    it('a faulting per-key read THROWS rather than DELETING the leaf (delete-on-zero)', async function(){
        const db = new FakeDb();
        db.write(500, ADDR, TICK, M.canonicalAmount('5'));
        db.failOn = 'ORDER BY j.id DESC LIMIT 1';
        await assert.rejects(
            () => ESC.applyEscrowLeaves(db, db.smt(), SC.EMPTY_ROOT_HEX, CHAIN, NETWORK, 500),
            /injected DB fault/,
            'a fail-soft [] here is delete-on-zero: the lock would vanish from balances_root');
    });

    it('a faulting live-set read THROWS rather than rebuilding balances_root with no locked leaves', async function(){
        // The quiet fork spec §3-B item 2 names: a full rebuild that silently
        // drops every locked leaf looks exactly like a healthy v1 root.
        const db = new FakeDb();
        db.write(500, ADDR, TICK, M.canonicalAmount('5'));
        db.failOn = 'INNER JOIN ( ';
        await assert.rejects(() => ESC.liveEscrowLeaves(db), /injected DB fault/);
    });
});

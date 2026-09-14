/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/escrow_leaf_subtree.test/xchain_esc_locked_leaf_the.test.js
 *
 * Sibling block of the escrow_leaf_subtree.test.js suite, carrying:
 *   XCHAIN_ESC locked leaf: the §7 shadow thread @regression
 *   XCHAIN_ESC locked leaf: strict reads @regression
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const M   = require('../../../src/consensus/merkle.js');
const SC  = require('../../../src/stateCommitment.js');
const SUB = require('../../../src/state_subtree_activation.js');
const ESC = require('../../../src/consensus/escrow_leaf_subtree.js');

const CHAIN = 'BTC', NETWORK = 'regtest';
const ADDR  = '1LockerAaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TICK  = 'XCHAIN';

// Fake db over the journal + the two index tables it joins. Rows are appended
// exactly as the source appends them: one per key whose total CHANGED in a block.
class FakeDb {
    constructor(){
        this.rows = []; this.nodes = new Map(); this.nextId = 1; this.journalQueries = 0;
        // Which reader each SQL string arrived through, plus fault injection.
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
        return await this.run(sql, args);
    }
    async doQueryStrict(sql, args){
        this.strictSql.push(sql);
        return await this.run(sql, args);
    }
    async run(sql, args){
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
        // Patch run, not doQuery: the module reads strictly now, and
        // overriding the soft reader would leave the shadow prior-row read
        // unstubbed while quietly passing.
        const orig = db.run.bind(db);
        db.run = async function(sql, args){
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
        // Patch run, not doQuery: the module reads strictly now, and
        // overriding the soft reader would leave the shadow prior-row read
        // unstubbed while quietly passing.
        const orig = db.run.bind(db);
        db.run = async function(sql, args){
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
        for(const p of ['../../../src/stateCommitment.js', '../../../../xchain-sync/src/stateCommitment.js']){
            let src;
            // The sync candidate is a sibling reference: an absent sibling still
            // falls through to the catch below, as it always has, but a present
            // one reached through a lane symlink into a live main checkout is
            // refused instead of read (the local candidate is this repo's own
            // file, never a sibling, so it keeps the plain read untouched).
            if(p.indexOf('xchain-sync') !== -1){
                const verdict = siblingCheckout(__dirname, p);
                if(!verdict.usable && fs.existsSync(verdict.path))
                    return skipOrFail(this, verdict, 'the shadow-value source pin against xchain-sync/src/stateCommitment.js');
            }
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
// The journal reads STRICTLY, so a DB fault halts instead of forking.
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
        // The quiet fork this test guards against: a full rebuild that silently
        // drops every locked leaf looks exactly like a healthy v1 root.
        const db = new FakeDb();
        db.write(500, ADDR, TICK, M.canonicalAmount('5'));
        db.failOn = 'INNER JOIN ( ';
        await assert.rejects(() => ESC.liveEscrowLeaves(db), /injected DB fault/);
    });
});

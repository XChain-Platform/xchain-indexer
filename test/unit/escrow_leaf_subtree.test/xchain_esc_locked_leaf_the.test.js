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
const M   = require('../../../src/consensus/merkle.js');
const SC  = require('../../../src/state_commitment/index.js');
const SUB = require('../../../src/state_subtree_activation.js');
const ESC = require('../../../src/consensus/escrow_leaf_subtree.js');

const { FakeDb, CHAIN, NETWORK, ADDR, TICK } = require('./helpers/fake_db');

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

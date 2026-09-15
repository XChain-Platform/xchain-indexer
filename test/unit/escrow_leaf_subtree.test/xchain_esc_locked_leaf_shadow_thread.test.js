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
 * test/unit/escrow_leaf_subtree.test/xchain_esc_locked_leaf_shadow_thread.test.js
 *
 * Sibling block of the escrow_leaf_subtree.test.js suite, carrying the tail of:
 *   XCHAIN_ESC locked leaf: the §7 shadow thread @regression
 *
 * The threading-equals-fresh-build vector and the shadow-value source pin, moved
 * out of xchain_esc_locked_leaf_the.test.js so each describe stays under the
 * function-length limit. Both blocks repeat the parent describe title, so the
 * full test titles are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const M   = require('../../../src/consensus/merkle.js');
const SC  = require('../../../src/stateCommitment.js');
const ESC = require('../../../src/consensus/escrow_leaf_subtree.js');

const { FakeDb, CHAIN, NETWORK, ADDR, TICK } = require('./helpers/fake_db');

describe('XCHAIN_ESC locked leaf: the §7 shadow thread @regression', function(){

    const balKey  = (addr) => M.balanceKey(CHAIN, NETWORK, addr, TICK);
    const balLeaf = (amt)  => M.toHex(M.leafHash(M.canonicalAmount(amt)));

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
});

describe('XCHAIN_ESC locked leaf: the §7 shadow thread @regression', function(){

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

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
 * test/unit/contract_state_subtree.test/contract_state_root_incremental_equals.test.js
 *
 * Sibling block of the contract_state_subtree.test.js suite, carrying:
 *   contract_state_root: incremental equals full build @regression
 *   contract_state_root: shadow-compute window @regression
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');

const SC  = require('../../../src/stateCommitment.js');
const SUB = require('../../../src/state_subtree_activation.js');
const CST = require('../../../src/consensus/contract_state_subtree.js');

const { FakeDb, EMPTY, armedAt, CHAIN, NETWORK } = require('./helpers/fake_db');

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

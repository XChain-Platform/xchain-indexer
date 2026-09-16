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
 * test/unit/contract_state_subtree.test/contract_state_root_shadow_derivation.test.js
 *
 * Sibling block of the contract_state_subtree.test.js suite, carrying the tail of:
 *   contract_state_root: shadow-compute window @regression
 *
 * The derivation vectors of the window (a shadow value never reaches state_root,
 * the shadow threads through its own column, the arming block does not inherit
 * it), moved out of contract_state_root_incremental_equals.test.js so each
 * describe stays under the function-length limit. The block repeats its parent
 * describe title, so the full test titles are the ones the entry collected
 * before the split.
 */
'use strict';

const assert = require('assert');

const SC  = require('../../../src/state_commitment/index.js');
const SUB = require('../../../src/state_subtree_activation.js');
const CST = require('../../../src/consensus/contract_state_subtree.js');

const { FakeDb, EMPTY, CHAIN, NETWORK } = require('./helpers/fake_db');
const { shadowFrom } = require('./helpers/shadow_window');

describe('contract_state_root: shadow-compute window @regression', function(){

    const SHADOW_FROM = 300, ARMED = 400;

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

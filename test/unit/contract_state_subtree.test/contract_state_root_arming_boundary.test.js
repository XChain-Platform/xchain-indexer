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
 * test/unit/contract_state_subtree.test/contract_state_root_arming_boundary.test.js
 *
 * Sibling block of the contract_state_subtree.test.js suite, carrying:
 *   contract_state_root: arming boundary and reorg @regression
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');

const M   = require('../../../src/consensus/merkle.js');
const SC  = require('../../../src/stateCommitment.js');
const SUB = require('../../../src/state_subtree_activation.js');
const CST = require('../../../src/consensus/contract_state_subtree.js');

const { FakeDb, EMPTY, armedAt, CHAIN, NETWORK } = require('./helpers/fake_db');

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

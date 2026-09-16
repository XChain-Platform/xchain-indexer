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

const CST = require('../../../src/consensus/contract_state_subtree.js');

const { FakeDb, EMPTY, armedAt, CHAIN, NETWORK } = require('./helpers/fake_db');
const { blockRow, V1_STATE_ROOT } = require('./helpers/block_row');

describe('contract_state_root: arming boundary and reorg @regression', function(){

    const ARMED = 500;

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
});

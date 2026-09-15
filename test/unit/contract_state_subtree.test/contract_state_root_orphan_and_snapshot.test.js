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
 * test/unit/contract_state_subtree.test/contract_state_root_orphan_and_snapshot.test.js
 *
 * Sibling block of the contract_state_subtree.test.js suite, carrying the tail of:
 *   contract_state_root: arming boundary and reorg @regression
 *
 * The orphaned-write revert and the snapshot-bootstrap agreement vectors, moved
 * out of contract_state_root_arming_boundary.test.js so each describe stays
 * under the function-length limit. The block repeats its parent describe title,
 * so the full test titles are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');

const { FakeDb, EMPTY, armedAt } = require('./helpers/fake_db');
const { blockRow, V1_STATE_ROOT } = require('./helpers/block_row');

describe('contract_state_root: arming boundary and reorg @regression', function(){

    const ARMED = 500;

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

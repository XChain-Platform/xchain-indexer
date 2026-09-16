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
 * test/unit/contract_state_subtree.test/contract_state_root_strict_reads.test.js
 *
 * Sibling block of the contract_state_subtree.test.js suite, carrying:
 *   contract_state_root: strict reads @regression
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');

const SC  = require('../../../src/state_commitment/index.js');
const SUB = require('../../../src/consensus/gates/state_subtree_gate.js');

const { FakeDb, EMPTY, armedAt, CHAIN, NETWORK } = require('./helpers/fake_db');

// ---------------------------------------------------------------------------
// The derivation reads STRICTLY, so a DB fault halts instead of forking.
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
});

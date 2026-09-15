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
 * test/unit/contract_state_subtree.test/contract_state_root_strict_read_faults.test.js
 *
 * Sibling block of the contract_state_subtree.test.js suite, carrying the tail of:
 *   contract_state_root: strict reads @regression
 *
 * The two fault-injection vectors (a faulting full build and a faulting
 * latest-value read both THROW), moved out of
 * contract_state_root_strict_reads.test.js so each describe stays under the
 * function-length limit. The block repeats its parent describe title, so the
 * full test titles are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');

const SC  = require('../../../src/stateCommitment.js');
const SUB = require('../../../src/state_subtree_activation.js');

const { FakeDb, armedAt, CHAIN, NETWORK } = require('./helpers/fake_db');

describe('contract_state_root: strict reads @regression', function(){

    const ARMED = 500;

    it('a faulting full build THROWS rather than committing EMPTY over a populated table', async function(){
        await armedAt(ARMED, async () => {
            const db = new FakeDb();
            db.write(ARMED - 1, 7, 'k', '"v"');
            db.failOn = 'INNER JOIN';                  // the MAX(id) full-build join
            await assert.rejects(
                () => SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED),
                /injected DB fault/,
                'the arming block must not commit EMPTY because its own read failed');
        });
    });

    it('a faulting latest-value read THROWS rather than DELETING the key from the tree', async function(){
        await armedAt(ARMED, async () => {
            const db = new FakeDb();
            db.write(ARMED, 7, 'a', '"1"');
            const c0 = await SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED);
            db.storeRoot(ARMED, SUB.gateSubRoots(c0, ARMED, NETWORK, CHAIN).contract_state_root);
            db.write(ARMED + 1, 7, 'a', '"2"');
            db.failOn = 'ORDER BY id DESC LIMIT 1';    // the per-key winning-row read
            await assert.rejects(
                () => SC.reservedSubRootCandidates(db, CHAIN, NETWORK, ARMED + 1),
                /injected DB fault/,
                'an empty winning-row read is the tombstone mapping, so it must never come from a fault');
        });
    });
});

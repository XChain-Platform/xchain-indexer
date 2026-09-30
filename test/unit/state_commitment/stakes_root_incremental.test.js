/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const M = require('../../../src/consensus/merkle.js');
const SC = require('../../../src/state_commitment/index.js');
const { keyFor, leafFor, CountingStore } = require(
    './state_commitment_batched_node_writes.test/helpers/counting_store.js');

const CHAIN = 'BTC';
const NETWORK = 'regtest';

function stakeEntries(n){
    const entries = [];
    for(let i = 0; i < n; i++)
        entries.push([M.toHex(keyFor('incremental-stake:' + i)), leafFor(i)]);
    return entries;
}

function freshSmt(){ return new SC.PersistentSMT(new CountingStore()); }

function fullRoot(entries){ return freshSmt().buildFull(entries); }

describe('stateCommitment: incremental stakes subtree updates @regression', function(){
    beforeEach(function(){ SC.resetStakesMemo(); });
    afterEach(function(){ SC.resetStakesMemo(); });

    it('updates a changed leaf, removes a key, and rebuilds after a gap', async function(){
        const smt = freshSmt();
        const initial = stakeEntries(90);
        await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, initial);

        const changed = initial.map(entry => entry.slice());
        changed[37][1] = leafFor(1000);
        let rowsBefore = smt.store.rowsWritten;
        const changedRoot = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 101, changed);
        const changedRows = smt.store.rowsWritten - rowsBefore;
        assert.strictEqual(changedRoot, await fullRoot(changed),
            'a changed leaf must produce the same root as a full build');
        assert.ok(changedRows > 0 && changedRows <= 512,
            'one changed leaf offered ' + changedRows + ' rows to the store');

        const removed = changed.filter((entry, index) => index !== 12);
        const removedRoot = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 102, removed);
        assert.strictEqual(removedRoot, await fullRoot(removed),
            'removing a key must produce the same root as a full build');

        rowsBefore = smt.store.rowsWritten;
        const gapRoot = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 105, removed);
        const gapRows = smt.store.rowsWritten - rowsBefore;
        assert.strictEqual(gapRoot, await fullRoot(removed),
            'a gap rebuild must produce the same root as a full build');
        assert.ok(gapRows > 512, 'a gap must rebuild instead of applying an incremental update');
    });
});

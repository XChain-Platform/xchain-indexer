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
const sinon = require('sinon');
const { getLogger } = require('../../../src/observability/index.js');
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

describe('stateCommitment: stakes subtree with a pubkey delegated by two sources @regression', function(){
    const PUBKEY = 'ab'.repeat(32);
    const CAP = 'duplicate_key_probe';
    const LOG_CAP = 'duplicate_key_log_probe';

    function dbReturning(rows, cap = CAP){
        return { config: { STAKING: { CAPABILITIES: { [cap]: {} } } },
                 getStakeWeightsByCapability: async () => rows };
    }
    const rowA = { pubkey: PUBKEY, source: 'a-source', weight: '1' };
    const rowB = { pubkey: PUBKEY, source: 'B-source', weight: '1' };

    beforeEach(function(){ SC.resetStakesMemo(); });
    afterEach(function(){ SC.resetStakesMemo(); sinon.restore(); });

    it('commits the member leaf of the row the query returns last', async function(){
        const entries = await SC.gatherStakeEntries(dbReturning([rowA, rowB]), 100);
        const key = M.toHex(M.stakeKey(PUBKEY, CAP));
        const lastWins = [[key, M.toHex(M.stakeMemberLeaf('B-source', '1'))],
                          entries[entries.length - 1]];
        assert.strictEqual(await fullRoot(entries), await fullRoot(lastWins));

        const swapped = await SC.gatherStakeEntries(dbReturning([rowB, rowA]), 100);
        assert.notStrictEqual(await fullRoot(swapped), await fullRoot(entries),
            'the committed root follows the query row order for a repeated key');
    });

    it('rebuilds when only the order of a repeated key changes', async function(){
        const smt = freshSmt();
        const first = await SC.gatherStakeEntries(dbReturning([rowA, rowB]), 100);
        const second = await SC.gatherStakeEntries(dbReturning([rowB, rowA]), 101);
        const firstRoot = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 100, first);
        const secondRoot = await SC.buildStakesRoot(smt, CHAIN, NETWORK, 101, second);
        assert.notStrictEqual(secondRoot, firstRoot);
        assert.strictEqual(secondRoot, await fullRoot(second));
    });

    it('logs a repeated key without throwing and stays quiet while the count is unchanged', async function(){
        const warn = sinon.stub(getLogger(), 'warn');
        await SC.gatherStakeEntries(dbReturning([rowA, rowB], LOG_CAP), 100);
        await SC.gatherStakeEntries(dbReturning([rowA, rowB], LOG_CAP), 101);
        assert.strictEqual(warn.callCount, 1);
        assert.ok(/repeated member key/.test(String(warn.firstCall.args[0])));
        await SC.gatherStakeEntries(dbReturning([rowA], LOG_CAP), 102);
        assert.strictEqual(warn.callCount, 1, 'a clean read logs nothing');
    });
});

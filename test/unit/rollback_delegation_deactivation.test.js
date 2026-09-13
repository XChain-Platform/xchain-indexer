// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Guards the `delegations.deactivation_block` re-NULL sweep in rollback.js.
//
// A DELEGATE revoke stamps an ALREADY-ACTIVE parent delegations row in place with
// BLOCK_INDEX + ACTIVATION_DELAY_BLOCKS. The sweep used to undo that by self-joining the
// parent to the revoke's own delegations row, but the revoke stopped writing that row at
// the DELEGATE_REVOKE_NO_REINSERT flag-day (actions/delegate.js), so the join matched
// nothing and a reorged node kept a delegation scheduled for removal that a from-genesis
// replay keeps active: a divergence in effective signer membership and stakes_root.
// The sweep is now the value-threshold form, which covers both sides of the flag-day.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../fixtures/mocks');

const Rollback = require('../../src/rollback.js');

// The delegations sweep, identified by its UPDATE target. `UPDATE contract_delegations`
// and the narrower ROLLCALL repair (`UPDATE delegations d JOIN rollcall_absences`) are
// deliberately excluded: this is the bare-table sweep only.
function delegationsSweeps(db){
    return db.doQuery.getCalls().filter(c =>
        typeof c.args[0] === 'string' && /UPDATE\s+delegations\s+SET/.test(c.args[0]));
}

describe('Rollback delegations deactivation sweep @regression @tier3', function(){
    let indexer, rollback;

    beforeEach(async function(){
        indexer = createMockIndexer();
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        // ACTIVATION_DELAY_BLOCKS is 6 in the BTC test config, so the threshold is 100 + 6.
        await rollback.rollback(100);
    });

    afterEach(function(){ sinon.restore(); });

    it('issues exactly one bare-table delegations re-NULL sweep', function(){
        assert.strictEqual(delegationsSweeps(indexer.indexerDb).length, 1);
    });

    it('does not depend on a child revoke row, which post-flag-day revokes no longer write', function(){
        const q = delegationsSweeps(indexer.indexerDb)[0].args[0];
        assert.ok(!/JOIN/i.test(q),
            'a self-join on the revoke row matches nothing once DELEGATE_REVOKE_NO_REINSERT is active');
        assert.ok(/deactivation_block\s+IS\s+NOT\s+NULL/.test(q), 'sweep must skip already-clear rows');
        assert.ok(/deactivation_block\s*>=\s*\?/.test(q), 'sweep must key on the value threshold');
    });

    it('keys the threshold at block_index + activationDelay, not at block_index', function(){
        // The precision boundary: a SURVIVING revoke at block b < 100 stamped b + 6, which for
        // b in [94, 99] lands at or above block_index. A blanket `>= block_index` sweep would
        // wrongly clear those legitimately earned deactivations; `>= block_index + delay` cannot,
        // because every writer of this column stamps actionBlock + ACTIVATION_DELAY_BLOCKS.
        const args = delegationsSweeps(indexer.indexerDb)[0].args[1];
        assert.deepStrictEqual(args, [106]);
        assert.notDeepStrictEqual(args, [100]);
    });

    it('runs before the orphaned delegations rows are deleted', function(){
        const calls    = indexer.indexerDb.doQuery.getCalls();
        const sweepIdx = calls.findIndex(c => typeof c.args[0] === 'string' &&
                                             /UPDATE\s+delegations\s+SET/.test(c.args[0]));
        const delIdx   = calls.findIndex(c => typeof c.args[0] === 'string' &&
                                             /DELETE\s+FROM\s+delegations\b/.test(c.args[0]));
        assert.ok(sweepIdx >= 0, 'sweep present');
        if(delIdx >= 0)
            assert.ok(sweepIdx < delIdx, 'the re-NULL sweep must precede the delegations delete');
    });
});

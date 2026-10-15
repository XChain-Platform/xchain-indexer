// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../../fixtures/mocks');

const Rollback = require('../../../../src/rollback/index.js');

// A block pass can flip a surviving row in a block that mints no actions row: the BET
// deadline latch stamps bet_feeds.closed_block, the DELEGATE v1 materialization journals a
// key rotation, a rollcall eviction stamps delegations. Rolling back a range made only of
// such blocks leaves firstActionIndex null, and the block-keyed resets must still run, or
// the rolled-back node keeps the feed closed and rejects a wager a fresh node accepts.

const BLOCK_KEYED = [
    ['attests reset',             (q) => /UPDATE attests/.test(q) && /resolved_block >= \?/.test(q)],
    ['xcalls reset',              (q) => /UPDATE xcalls/.test(q) && /resolved_block >= \?/.test(q)],
    ['polls re-open',             (q) => /UPDATE polls/.test(q) && /poll_status = 'open'/.test(q)],
    ['bet feed latch reset',      (q) => /UPDATE bet_feeds f/.test(q) && /SET f\.feed_status_id = os\.id, f\.closed_block = NULL/.test(q)],
    ['bet feed terminal reset',   (q) => /UPDATE bet_feeds f/.test(q) && /f\.terminal_block >= \?/.test(q)],
    ['bet settlement reset',      (q) => /UPDATE bets b/.test(q) && /settled_block >= \?/.test(q)],
    ['poll callback re-arm',      (q) => /UPDATE polls/.test(q) && /callback_due_block >= \?/.test(q)],
    ['delegations deactivation',  (q) => /UPDATE delegations/.test(q) && /deactivation_block = NULL/.test(q)],
    ['contract delegations',      (q) => /UPDATE contract_delegations/.test(q) && /deactivation_block = NULL/.test(q)],
    ['contract slash restore',    (q) => /JOIN contract_slash_debits d ON/.test(q) && /SET t\.amount = d\.prev_amount/.test(q)],
    ['delegation rotation restore', (q) => /JOIN contract_delegation_rotations r ON/.test(q) && /SET t\.signing_pubkey_id = r\.prev_signing_pubkey_id/.test(q)],
    ['capability slash restore',  (q) => /JOIN capability_slash_debits d ON/.test(q) && /SET t\.amount = d\.prev_amount/.test(q)],
];

function setup(){
    const indexer = createMockIndexer();
    indexer.protocolChanges = {
        isDefined: sinon.stub().returns(true),
        isEnabled: sinon.stub().resolves(true),
    };
    const rollback = new Rollback(indexer);
    indexer.util.resetLists();
    return { indexer, rollback };
}

describe('Rollback over an action-empty range @regression @tier3', function () {

    it('runs every block-keyed in-place reset when the orphaned range holds no actions', async function () {
        const { indexer, rollback } = setup();
        // Every read returns nothing, so the read phase finds no orphaned action.
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(6);
        const sql = indexer.indexerDb.doQuery.getCalls().map(c => String(c.args[0]));
        for (const [name, match] of BLOCK_KEYED)
            assert.ok(sql.some(match), 'expected the ' + name + ' on an action-empty rollback');
        const latch = indexer.indexerDb.doQuery.getCalls().find(c => BLOCK_KEYED[3][1](String(c.args[0])));
        assert.deepStrictEqual(latch.args[1], [6], 'the latch reset keys on the rollback height');
    });

    it('keeps the action-range resets behind the guard when there is no orphaned action', async function () {
        const { indexer, rollback } = setup();
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(6);
        const sql = indexer.indexerDb.doQuery.getCalls().map(c => String(c.args[0]));
        assert.ok(!sql.some(q => /DELETE FROM contract_emissions/.test(q)), 'no emission delete without an action range');
        assert.ok(!sql.some(q => /UPDATE anchor_actions p/.test(q)), 'no archive head reset without an action range');
    });

    it('still runs the bet resets before the action-scoped deletes when the range has actions', async function () {
        const { indexer, rollback } = setup();
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(6);
        const calls = indexer.indexerDb.doQuery.getCalls().map(c => String(c.args[0]));
        const latch = calls.findIndex(BLOCK_KEYED[3][1]);
        const generic = calls.findIndex(q => /DELETE FROM \w+ WHERE action_index\s*>=/.test(q));
        assert.ok(latch >= 0, 'expected the bet latch reset');
        assert.ok(generic >= 0, 'expected the generic action-range delete');
        assert.ok(latch < generic, 'the latch reset reads surviving rows before the generic delete');
    });
});

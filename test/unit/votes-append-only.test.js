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
 **********************************************************************
 * test/unit/votes-append-only.test.js
 *
 * Reorg-safety guard for the append-only votes design. The original
 * delete-then-insert createBallot destroyed the voter's prior ballot on a
 * re-vote, which a reorg orphaning the replacement could never restore (the
 * prior ballot's block sits below the rollback point and never reprocesses),
 * forking a reorged node's tally from a from-genesis replay. These tests pin
 * the two halves of the fix: the writer never deletes, and the tally reads
 * only each voter's latest (MAX action_index) ballot set.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const fs     = require('fs');
const path   = require('path');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:            sinon.stub().resolves([]),
        release:          sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves()
    }) };
    return db;
}

describe('votes append-only (reorg safety) @regression @tier1', function () {

    afterEach(() => sinon.restore());

    it('createBallot never deletes prior rows and inserts one row per selection', async function () {
        const db = makeDb();
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => { calls.push({ sql, args }); return []; });
        sinon.stub(db, 'createAddress').resolves(42);
        sinon.stub(db, 'createStatus').resolves(5);

        await db.createBallot(
            { ACTION_INDEX: 200, BLOCK_INDEX: 150, POLL_REF: 100, SOURCE: 'addr1', STATUS: 'valid', MEMO: null },
            [{ choice: 0, share: '1' }, { choice: 2, share: '1' }]
        );

        const deletes = calls.filter(c => /DELETE/i.test(c.sql));
        assert.deepStrictEqual(deletes, [],
            'createBallot must not DELETE prior ballot rows; a re-vote must be a new append-only ' +
            'action_index set or a reorg orphaning the replacement loses the prior ballot forever');
        const inserts = calls.filter(c => /INSERT INTO votes/i.test(c.sql));
        assert.strictEqual(inserts.length, 2, 'one INSERT per ballot selection');
        for (const ins of inserts) assert.strictEqual(ins.args[0], 200, 'rows keyed by the v1 action_index');
    });

    it('getPollTally counts only each voter\'s latest ballot set (MAX action_index filter)', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPoll').resolves({
            action_index: 100, block_index: 90, tick_id: 7, end_block: 500,
            options: '["yes","no"]', max_selections: 1, tally_mode: 'approval',
            weight_mode: 'balance', quorum: null, min_voters: null, min_vote_balance: null
        });
        sinon.stub(db, 'getTicker').resolves('TKN');
        sinon.stub(db, 'getHolders').resolves({ alice: '10', bob: '4' });
        sinon.stub(db, 'getActiveDelegations').resolves({});
        sinon.stub(db, 'getLatestBlockIndex').resolves(400);

        let votesSql = null;
        sinon.stub(db, 'doQuery').callsFake(async (sql) => {
            if (/FROM votes/i.test(sql)) {
                votesSql = sql;
                // What the current-ballot filter would return: alice's re-vote (her
                // latest set picks "no"); her superseded "yes" row is filtered out.
                return [
                    { address: 'alice', choice: 1, share: '1' },
                    { address: 'bob',   choice: 0, share: '1' }
                ];
            }
            return [];
        });

        const tally = await db.getPollTally(100);
        assert.ok(/MAX\(v2\.action_index\)/.test(votesSql),
            'tally query must restrict each voter to their latest (MAX action_index) ballot set; ' +
            'without the filter every superseded append-only ballot would be double-counted');
        assert.strictEqual(tally.options[0].weight, '4',  'bob\'s current ballot only');
        assert.strictEqual(tally.options[1].weight, '10', 'alice\'s latest ballot, superseded set excluded by the query');
        assert.strictEqual(tally.winning_option, 1);
    });

    it('schema + migration pin the widened unique key (append-only enforcement)', function () {
        const schema = fs.readFileSync(path.resolve(__dirname, '../../src/sql/votes.sql'), 'utf8');
        assert.ok(/UNIQUE INDEX poll_voter_action_choice ON votes \(poll_index, voter_address_id, action_index, choice\)/.test(schema),
            'votes.sql must key uniqueness by (poll, voter, action, choice) so re-vote sets can coexist');
        assert.ok(!/UNIQUE INDEX poll_voter_choice /.test(schema),
            'the old (poll, voter, choice) unique key would reject any append-only re-vote');
        const mig = fs.readFileSync(path.resolve(__dirname,
            '../../src/sql/migrations/2026-07-03-votes-append-only-unique-idx.sql'), 'utf8');
        assert.ok(/mode=auto/.test(mig) && /DROP INDEX IF EXISTS poll_voter_choice/.test(mig),
            'existing DBs need the auto migration that drops the old unique key');
    });
});

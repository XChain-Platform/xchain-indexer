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
 * test/unit/votes-tally-invariants.test.js
 *
 * Regression coverage for two VOTE governance invariants that had zero
 * tests (review finding #149): delegation-vs-direct precedence and
 * quadratic weighting / the dust-floor participation gate, both in
 * db.getPollTally. Modeled on the getPollTally stub harness in
 * votes-append-only.test.js.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

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

function basePoll(overrides = {}) {
    return {
        action_index: 100, block_index: 90, tick_id: 7, end_block: 500,
        options: '["yes","no"]', max_selections: 1, tally_mode: 'approval',
        weight_mode: 'balance', quorum: null, min_voters: null, min_vote_balance: null,
        ...overrides,
    };
}

describe('VOTE tally invariants (delegation precedence + quadratic/dust floor) @regression @tier1', function () {

    afterEach(() => sinon.restore());

    describe('delegation-vs-direct precedence', function () {

        it('an idle delegator (did not vote) lends full weight to a delegate who did vote', async function () {
            const db = makeDb();
            sinon.stub(db, 'getPoll').resolves(basePoll());
            sinon.stub(db, 'getTicker').resolves('TKN');
            sinon.stub(db, 'getHolders').resolves({ alice: '10', bob: '5' });
            sinon.stub(db, 'getActiveDelegations').resolves({ alice: 'bob' }); // alice -> bob
            sinon.stub(db, 'getLatestBlockIndex').resolves(600);
            sinon.stub(db, 'doQuery').callsFake(async (sql) => {
                if (/FROM votes/i.test(sql))
                    return [{ address: 'bob', choice: 0, share: '1' }]; // only bob voted directly
                return [];
            });

            const tally = await db.getPollTally(100);
            assert.strictEqual(tally.options[0].weight, '15',
                'bob\'s own balance (5) plus alice\'s delegated balance (10) = 15');
        });

        it('a direct vote overrides a standing delegation: the delegator\'s weight does NOT flow to the delegate', async function () {
            const db = makeDb();
            sinon.stub(db, 'getPoll').resolves(basePoll());
            sinon.stub(db, 'getTicker').resolves('TKN');
            sinon.stub(db, 'getHolders').resolves({ alice: '10', bob: '5' });
            sinon.stub(db, 'getActiveDelegations').resolves({ alice: 'bob' }); // alice standing-delegates to bob
            sinon.stub(db, 'getLatestBlockIndex').resolves(600);
            sinon.stub(db, 'doQuery').callsFake(async (sql) => {
                if (/FROM votes/i.test(sql))
                    // alice votes DIRECTLY for option 1 (overrides her delegation); bob votes option 0
                    return [
                        { address: 'alice', choice: 1, share: '1' },
                        { address: 'bob',   choice: 0, share: '1' }
                    ];
                return [];
            });

            const tally = await db.getPollTally(100);
            assert.strictEqual(tally.options[0].weight, '5',
                'bob only gets his own balance; alice voting directly must not also flow to bob');
            assert.strictEqual(tally.options[1].weight, '10', 'alice\'s direct vote counts at her own balance');
        });

        it('a delegator who no longer holds the token at close contributes no delegated weight', async function () {
            const db = makeDb();
            sinon.stub(db, 'getPoll').resolves(basePoll());
            sinon.stub(db, 'getTicker').resolves('TKN');
            sinon.stub(db, 'getHolders').resolves({ bob: '5' }); // alice sold out before close, absent from holders
            sinon.stub(db, 'getActiveDelegations').resolves({ alice: 'bob' });
            sinon.stub(db, 'getLatestBlockIndex').resolves(600);
            sinon.stub(db, 'doQuery').callsFake(async (sql) => {
                if (/FROM votes/i.test(sql))
                    return [{ address: 'bob', choice: 0, share: '1' }];
                return [];
            });

            const tally = await db.getPollTally(100);
            assert.strictEqual(tally.options[0].weight, '5',
                'a delegator who no longer holds TICK at close must not inflate the delegate\'s weight');
        });
    });

    describe('quadratic weighting / dust-floor participation gate', function () {

        it('quadratic mode weights every counted ballot by sqrt(close balance), not the raw balance', async function () {
            const db = makeDb();
            sinon.stub(db, 'getPoll').resolves(basePoll({ weight_mode: 'quadratic', min_vote_balance: '1' }));
            sinon.stub(db, 'getTicker').resolves('TKN');
            // 100 and 25 are perfect squares so sqrt weighting is exact and unambiguous.
            sinon.stub(db, 'getHolders').resolves({ alice: '100', bob: '25' });
            sinon.stub(db, 'getActiveDelegations').resolves({});
            sinon.stub(db, 'getLatestBlockIndex').resolves(600);
            sinon.stub(db, 'doQuery').callsFake(async (sql) => {
                if (/FROM votes/i.test(sql))
                    return [
                        { address: 'alice', choice: 0, share: '1' },
                        { address: 'bob',   choice: 1, share: '1' }
                    ];
                return [];
            });

            const tally = await db.getPollTally(100);
            assert.strictEqual(tally.options[0].weight, '10', 'alice: sqrt(100) = 10, not the raw balance 100');
            assert.strictEqual(tally.options[1].weight, '5',  'bob: sqrt(25) = 5, not the raw balance 25');
        });

        it('a ballot below the min_vote_balance dust floor still counts weight but not toward min_voters participation', async function () {
            const db = makeDb();
            // min_voters=2 with a hard floor of 5: only holders >= 5 count toward it.
            sinon.stub(db, 'getPoll').resolves(basePoll({ weight_mode: 'quadratic', min_vote_balance: '5', min_voters: 2 }));
            sinon.stub(db, 'getTicker').resolves('TKN');
            sinon.stub(db, 'getHolders').resolves({ alice: '100', dust: '1' }); // dust < min_vote_balance(5)
            sinon.stub(db, 'getActiveDelegations').resolves({});
            sinon.stub(db, 'getLatestBlockIndex').resolves(600);
            sinon.stub(db, 'doQuery').callsFake(async (sql) => {
                if (/FROM votes/i.test(sql))
                    return [
                        { address: 'alice', choice: 0, share: '1' },
                        { address: 'dust',  choice: 0, share: '1' }
                    ];
                return [];
            });

            const tally = await db.getPollTally(100);
            // Current behavior: the dust floor gates the min_voters participation count,
            // NOT the weight itself (weight only requires closeBal > 0). A dust holder's
            // sqrt(1)=1 weight still lands in the total; only qualifying-voter count is gated.
            assert.strictEqual(tally.options[0].weight, '11', 'sqrt(100)=10 plus the dust voter\'s sqrt(1)=1 still totals 11');
            assert.strictEqual(tally.total_voters, 1, 'only alice (>= min_vote_balance) counts toward min_voters participation');
            assert.strictEqual(tally.min_voters_met, false, 'one qualifying voter is below the min_voters=2 gate');
        });
    });
});

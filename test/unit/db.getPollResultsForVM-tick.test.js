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
 * test/unit/db.getPollResultsForVM-tick.test.js
 *
 * CONSENSUS REGRESSION GUARD for the  VOTE_POLL_TICK_VISIBLE flag-day.
 *
 * getPollResultsForVM() builds the finalized-poll snapshot a contract observes through
 * xchain.getPollResult(). Exposing the poll's electorate TICK is a consensus change:
 * the KEY's mere PRESENCE in a snapshot entry is what a contract can observe (via the
 * accessor / Object.keys / JSON), so a from-genesis replay of a pre-flag block must
 * produce the exact pre-flag entry shape (no `tick` key), and an at/after-flag block
 * must carry the `tick`. This guards both halves of that gate against a regression that
 * would fork a heterogeneous fleet on the first tick-reading contract.
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
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

// One finalized poll (action_index 100, electorate tick GOVTOK) with two option rows.
function stubPollQueries(db) {
    sinon.stub(db, 'doQuery').callsFake(async (sql) => {
        if (/FROM\s+polls\b/i.test(sql)) {
            return [{
                action_index: 100, poll_status: 'finalized', winning_option: 1,
                total_weight: '15', total_voters: 2, decided_early: 0, tick: 'GOVTOK'
            }];
        }
        if (/FROM\s+poll_results\b/i.test(sql)) {
            return [
                { option_index: 0, total_weight: '5',  voter_count: 1 },
                { option_index: 1, total_weight: '10', voter_count: 1 }
            ];
        }
        return [];
    });
}

afterEach(function () { sinon.restore(); });

describe('getPollResultsForVM() VOTE_POLL_TICK_VISIBLE tick gating @regression @tier1', function () {

    it('includeTick=false: entry shape is byte-identical to the pre-flag snapshot (no `tick` key)', async function () {
        const db = makeDb();
        stubPollQueries(db);

        const snap  = await db.getPollResultsForVM(500, false);
        const entry = snap.polls['100'];

        assert.ok(entry, 'the finalized poll is present in the snapshot');
        assert.ok(!('tick' in entry), 'no `tick` key below the flag-day');
        assert.deepStrictEqual(Object.keys(entry).sort(),
            ['decided_early', 'options', 'status', 'total_voters', 'total_weight', 'winning_option'],
            'exact pre-flag key set');
    });

    it('includeTick=true: entry carries the resolved electorate `tick`', async function () {
        const db = makeDb();
        stubPollQueries(db);

        const snap  = await db.getPollResultsForVM(500, true);
        const entry = snap.polls['100'];

        assert.strictEqual(entry.tick, 'GOVTOK', 'the electorate tick is exposed at/after the flag-day');
        // The rest of the entry is unchanged by the gate.
        assert.strictEqual(entry.status, 'finalized');
        assert.strictEqual(entry.winning_option, 1);
        assert.deepStrictEqual(entry.options.map(o => o.index), [0, 1]);
    });

    it('includeTick default is false (a caller that omits the gate gets the pre-flag shape)', async function () {
        const db = makeDb();
        stubPollQueries(db);

        const entry = (await db.getPollResultsForVM(500)).polls['100'];
        assert.ok(!('tick' in entry), 'omitting the gate argument must default to the pre-flag shape');
    });

    it('includeTick=true with a NULL electorate tick: `tick` is present and null', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').callsFake(async (sql) => {
            if (/FROM\s+polls\b/i.test(sql)) {
                return [{
                    action_index: 100, poll_status: 'failed_quorum', winning_option: null,
                    total_weight: '0', total_voters: 0, decided_early: 0, tick: null
                }];
            }
            return [];
        });

        const entry = (await db.getPollResultsForVM(500, true)).polls['100'];
        assert.ok('tick' in entry, 'the tick key is present when the gate is on');
        assert.strictEqual(entry.tick, null, 'an unresolved electorate tick surfaces as null');
    });
});

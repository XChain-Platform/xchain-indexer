/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/regression/vote_ballot_column_verdicts.test.js
 *
 * A valid VOTE v1 ballot binds only what its votes row stores.
 *
 * The ballot names its poll by POLL_REF as parseInt reads it, but createBallot bound the
 * raw text into votes.poll_index BIGINT UNSIGNED, so a hexadecimal POLL_REF or one whose
 * exponent passes the column (errno 1366 or 1264) was a valid ballot whose insert failed.
 * A split share longer than votes.share VARCHAR(60) failed the same way (errno 1406), and
 * a poll storing more than 65536 entries offered choices past votes.choice SMALLINT
 * UNSIGNED (errno 1264). Each halted every indexer on the block that carried it, so the
 * refusals here carry no activation height. POLL_REF is judged as the column converts it,
 * rounding the exact decimal half away from zero, so U64_MAX + '.4999999999999' stays valid.
 *
 * Such a poll's finalize writes poll_results only for indexes up to 65535, which every
 * reader takes as zero beyond: no ballot can name a higher option, so none counts there.
 *
 * Every row runs the real handler, then the real row writer, and checks each bound value
 * against the strict-conversion model read from the shipped DDL. Rows marked valid or
 * with an existing verdict are the controls: values the columns store today, and refusals
 * whose verdict must not move.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData }   = require('../fixtures/mocks');
const { freshVote }        = require('../unit/actions/stake/vote_invariants.test/helpers/vote_fixtures.js');
const { columnAccepts }    = require('../helpers/strict_columns.js');
const votesDb              = require('../../src/db/votes/index.js');
const pollsDb              = require('../../src/db/polls/index.js');
const Utility              = require('../../src/utility');
const { finalizeInserts, OPTION_INDEX_AT } = require('../helpers/poll_finalize.js');

const U64_MAX = '18446744073709551615';

// A poll storing 65537 entries: createPoll keeps the empty ones its option count skips.
const OPTIONS_PAST_INDEX = 'yes,no' + ','.repeat(65535);

// A poll row as getPoll hands it back.
function pollRow(o = {}){
    return Object.assign({ action_index: 5, end_block: '200', poll_status: 'open', tick_id: 1,
                           options: JSON.stringify(['yes', 'no']), max_selections: 2, tally_mode: 'approval' }, o);
}
const SPLIT = { tally_mode: 'split' };
const POLL_PAST_INDEX = { options: JSON.stringify(OPTIONS_PAST_INDEX.split(',').map(o => o.trim())) };

// Run one ballot (VERSION|POLL_REF|BALLOT|MEMO) through the handler and the real createBallot;
// returns the status and every votes INSERT the row writer bound.
async function runVoteBallot(pollRef, ballot, poll){
    const { indexer, handler } = freshVote();
    indexer.indexerDb.getPoll = sinon.stub().callsFake(async i => (i === poll.action_index ? poll : null));
    indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
    const inserts = [];
    const rowDb = Object.assign({
        util: indexer.util,
        createStatus:  async () => 9,
        createAddress: async () => 3,
        doQuery: async (sql, args) => { if(/INSERT INTO votes/.test(sql)) inserts.push(args); return []; },
    }, votesDb);
    indexer.indexerDb.createBallot = (data, selections) => rowDb.createBallot(data, selections);
    const data = createBaseData({ ACTION: 'VOTE', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60, SOURCE: 'voterAddr' });
    await handler.parse(['1', pollRef, ballot, ''], data, null);
    return { status: data.STATUS, inserts };
}

// votes INSERT order: action_index, block_index, poll_index, voter_address_id, choice, share, memo, status_id.
const VOTE_ROW_COLUMNS = { poll_index: 2, choice: 4, share: 5 };

const BALLOT_CASES = [
    // POLL_REF names the poll as parseInt reads it, and binds raw into BIGINT UNSIGNED.
    ['POLL_REF of the poll index',                  '5',    '0', {},     'valid'],
    ['POLL_REF with a fraction the column rounds',  '5.4',  '0', {},     'valid'],
    ['POLL_REF in exponent form the column converts', '5e0', '0', {},    'valid'],
    ['POLL_REF as a hexadecimal literal',           '0x5',  '0', {},     'invalid: POLL_REF (format)'],
    ['POLL_REF of 5e30',                            '5e30', '0', {},     'invalid: POLL_REF (format)'],
    ['POLL_REF whose exponent form is the column maximum', '1.8446744073709551615e19', '0', { action_index: 1 }, 'valid'],
    ['POLL_REF whose exponent form is one past the column maximum', '1.8446744073709551616e19', '0', { action_index: 1 },
        'invalid: POLL_REF (format)'],
    // parseInt reads a plain U64_MAX fraction as the Number 2^64, and the exponent forms as 18446.
    ['POLL_REF just under half past the column maximum, which the column rounds down', U64_MAX + '.4999999999999', '0',
        { action_index: 2 ** 64 }, 'valid'],
    ['POLL_REF half past the column maximum, which the column rounds up past it', U64_MAX + '.5', '0',
        { action_index: 2 ** 64 }, 'invalid: POLL_REF (format)'],
    ['POLL_REF in exponent form just under half past the column maximum', '18446.7440737095516154999999999999e15', '0',
        { action_index: 18446 }, 'valid'],
    ['POLL_REF in exponent form half past the column maximum', '18446.7440737095516155e15', '0',
        { action_index: 18446 }, 'invalid: POLL_REF (format)'],
    ['a hexadecimal POLL_REF on a closed poll keeps its verdict', '0x5', '0', { end_block: '50' }, 'invalid: poll closed'],
    // A split share binds as trimmed text into VARCHAR(60); approval mode binds '1'.
    ['a split share of 60 characters, the column width', '5', '0:' + '1'.repeat(60), SPLIT, 'valid'],
    ['a split share of 61 characters',              '5', '0:' + '1'.repeat(61), SPLIT,     'invalid: BALLOT (length)'],
    ['a split share over the width keeps a later entry\'s verdict', '5', '0:' + '1'.repeat(61) + ',1:0', SPLIT,
        'invalid: BALLOT (share must be > 0 in split mode)'],
    ['an approval share over the width, which binds 1', '5', '0:' + '1'.repeat(61), {},     'valid'],
    // choice binds into SMALLINT UNSIGNED; only a poll storing more entries can offer more.
    ['a choice of 65535, the last index the column stores', '5', '65535', POLL_PAST_INDEX, 'valid'],
    ['a choice of 65536 on a poll storing 65537 entries', '5', '65536', POLL_PAST_INDEX,   'invalid: BALLOT (format)'],
];

describe('VOTE v1 refuses a value its votes row cannot store @regression @tier1', function () {
    afterEach(() => sinon.restore());

    for (const [title, pollRef, ballot, pollOverrides, expected] of BALLOT_CASES) {
        it(title + ' -> ' + expected, async function () {
            const { status, inserts } = await runVoteBallot(pollRef, ballot, pollRow(pollOverrides));
            assert.strictEqual(status, expected);
            if (expected !== 'valid')
                return assert.strictEqual(inserts.length, 0, 'a refused ballot writes no votes row');
            assert.ok(inserts.length > 0, 'createBallot wrote no row');
            for (const args of inserts)
                for (const [column, at] of Object.entries(VOTE_ROW_COLUMNS))
                    assert.ok(columnAccepts('votes', column, args[at]),
                        'votes.' + column + ' bound ' + String(args[at]) + ', which its column refuses');
        });
    }
});

describe('VOTE v2 writes only the poll_results rows their column stores @regression @tier1', function () {
    const stored = OPTIONS_PAST_INDEX.split(',').map(o => o.trim());

    it('the finalize of a poll storing 65537 entries writes indexes 0 to 65535', async function () {
        // It builds 65537 rows, and the 30 s default is too tight on a loaded CI venue.
        this.timeout(120000);
        const inserts = await finalizeInserts(stored);
        assert.strictEqual(inserts.length, 65536);
        assert.strictEqual(inserts[inserts.length - 1][OPTION_INDEX_AT], 65535);
        for (const args of inserts)
            assert.ok(columnAccepts('poll_results', 'option_index', args[OPTION_INDEX_AT]),
                'poll_results.option_index bound ' + args[OPTION_INDEX_AT]);
    });

    it('getPollResult reads the unwritten option 65536 at weight 0 and no voters', async function () {
        // It builds 65537 rows, and the 30 s default is too tight on a loaded CI venue.
        this.timeout(120000);
        const rows = (await finalizeInserts(stored)).map(a => ({ option_index: a[3], total_weight: a[4], voter_count: a[5] }));
        const db = Object.assign({}, pollsDb, {
            util: new Utility(),
            getPoll: async () => ({ action_index: 50, options: JSON.stringify(stored), poll_status: 'finalized', tick_id: null }),
            doQuery: async () => rows,
        });
        const result = await db.getPollResult(50);
        assert.strictEqual(result.options.length, 65537);
        assert.deepStrictEqual(result.options[65536], { index: 65536, label: '', weight: '0', voters: 0 });
        assert.deepStrictEqual(result.options[65535], { index: 65535, label: '', weight: '0', voters: 0 });
    });
});

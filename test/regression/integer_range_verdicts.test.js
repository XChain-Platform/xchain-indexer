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
 * test/regression/integer_range_verdicts.test.js
 *
 * A wire value its column cannot store never reaches the bind.
 *
 * VOTE v0 read END_BLOCK, MAX_SELECTIONS, MIN_VOTERS and CALLBACK_DELAY_BLOCKS through
 * Number or parseInt and wrote the live poll row with values a strict session refuses
 * (errno 1264, 1265 or 1366), so the block retried forever. ISSUE|7 admitted a MIN_DEPTH
 * of any digit count into issues.min_depth VARCHAR(15) (errno 1406), and a refused ATTEST
 * v0 or ISSUE|7 wrote its row with the raw wire value. Each such action halted every
 * indexer, so the verdicts here carry no activation height. A binding poll whose
 * CALLBACK_DELAY_BLOCKS its column stored could still halt at the finalize, which stamps
 * callback_due_block = finalize block + delay; that delay is refused the same way.
 *
 * Every table row runs the real handler, then the real row writer, and checks the bound
 * value against a strict-conversion model read from the shipped DDL. Rows marked
 * 'valid' or with an existing verdict are the byte-identical controls: values a column
 * stores today, and refusals whose verdict must not move.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');
const mathjs = require('mathjs');

const { createBaseData }   = require('../fixtures/mocks');
const { getTestConfig }    = require('../fixtures/config');
const { freshVote }        = require('../unit/actions/stake/vote_invariants.test/helpers/vote_fixtures.js');
const { setUpAttestHandler, v0Data, v0Params } = require('../helpers/attest_fixture.js');
const issueFixtures        = require('../unit/bridge/issue_bridge_optin.test/helpers/issue_fixtures.js');
const pollCreate           = require('../../src/db/polls/poll_create.js');
const bindingCallback      = require('../../src/actions/vote/binding_callback.js');
const { exactU64 }         = require('../../src/db/database/exact_u64.js');
const Utility              = require('../../src/utility');
const Database             = require('../../src/db');

const U64_MAX  = '18446744073709551615';
const OVER_U64 = '18446744073709551616';
const SQL_DIR  = path.join(__dirname, '../../src/sql');

// Column definition as the shipped DDL states it.
function columnSpec(table, column){
    const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    const parsed = Database.prototype.parseExpectedColumns.call(
        { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
    const col = parsed.find(c => c.name === column);
    assert.ok(col, table + '.' + column + ' is absent from its schema definition');
    return col.definition;
}

// Strict-session conversion of a bound value. A Number binds as its JavaScript text
// (NaN and Infinity unquoted), a string as itself. Integer columns take a plain decimal
// spelling rounded half away from zero inside the type's range; VARCHAR(n) takes at most
// n characters; NULL only where the column allows it.
function columnAccepts(table, column, value){
    const spec = columnSpec(table, column);
    if(value === null || value === undefined)
        return !/\bNOT\s+NULL\b/i.test(spec);
    const raw = String(value).trim();
    const text = /\bVARCHAR\((\d+)\)/i.exec(spec);
    if(text)
        return Array.from(String(value)).length <= Number(text[1]);
    const type = /\b(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)\b/i.exec(spec);
    assert.ok(type, table + '.' + column + ' is neither an integer nor a VARCHAR column');
    const bits = { TINYINT: 8, SMALLINT: 16, MEDIUMINT: 24, INT: 32, BIGINT: 64 }[type[1].toUpperCase()];
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw))
        return false;
    const n = mathjs.round(mathjs.bignumber(raw));
    const unsigned = /\bUNSIGNED\b/i.test(spec);
    const lo = unsigned ? mathjs.bignumber(0) : mathjs.bignumber(2).pow(bits - 1).neg();
    const hi = unsigned ? mathjs.bignumber(2).pow(bits).minus(1) : mathjs.bignumber(2).pow(bits - 1).minus(1);
    return n.isFinite() && n.gte(lo) && n.lte(hi);
}

// ── VOTE v0 ───────────────────────────────────────────────────────────────────

// VERSION|TICK|END_BLOCK|OPTIONS|MAX_SELECTIONS|TALLY_MODE|WEIGHT_MODE|QUORUM|MIN_VOTERS|
// MIN_VOTE_BALANCE|DECIDE_THRESHOLD|QUESTION|DEPOSIT|CALLBACK_CONTRACT|CALLBACK_METHOD|
// CALLBACK_PARAMS|CALLBACK_ON|GAS_ESCROW|CALLBACK_DELAY_BLOCKS. A binding poll by default.
function voteParams(o = {}){
    const p = Object.assign({ endBlock: '200', options: 'yes,no', maxSelections: '', minVoters: '3',
                              contract: '5', method: 'onResult', delay: '20' }, o);
    return ['0', 'TEST', p.endBlock, p.options, p.maxSelections, '', '', '0.1', p.minVoters, '', '', '', '',
            p.contract, p.method, '', '', '', p.delay];
}
const SIGNALING = { contract: '', method: '', delay: '' };
const MANY_OPTIONS = Array.from({ length: 65536 }, (_, i) => 'o' + i).join(',');

// Run one create through the handler and the real createPoll; returns the status and the
// INSERT arguments the row writer bound.
async function runVoteCreate(params){
    const { indexer, handler } = freshVote();
    indexer.indexerDb.getTokenInfo.resolves({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0, SUPPLY: '1000' });
    indexer.indexerDb.createTicker.resolves(1);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
    indexer.indexerDb.getContract = sinon.stub().resolves({ action_index: 5, code: 'module.exports={onResult:function(){}}', status_id: 1 });
    indexer.indexerDb.getStatusString = sinon.stub().resolves('valid');
    let bound = null;
    const rowDb = Object.assign({
        util: indexer.util,
        createTicker:  async () => 1,
        createStatus:  async () => 9,
        createAddress: async () => 3,
        doQuery: async (sql, args) => { if(/INSERT INTO polls/.test(sql)) bound = args; return []; },
    }, pollCreate);
    indexer.indexerDb.createPoll = (data, opts) => rowDb.createPoll(data, opts);
    const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 50, SOURCE: 'creatorAddr' });
    await handler.parse(params, data, null);
    return { status: data.STATUS, bound };
}

const POLL_COLUMNS = { end_block: 2, max_selections: 4, min_voters: 8, callback_delay_blocks: 19 };

const VOTE_CASES = [
    // END_BLOCK binds raw into BIGINT UNSIGNED.
    ['END_BLOCK at the column maximum',             { endBlock: U64_MAX },                   'valid'],
    ['END_BLOCK one past the column maximum',       { endBlock: OVER_U64 },                  'invalid: END_BLOCK (format)'],
    ['END_BLOCK of 23 digits',                      { endBlock: '10000000000000000000000' }, 'invalid: END_BLOCK (format)'],
    ['END_BLOCK as a hexadecimal literal',          { endBlock: '0x7fffffff' },              'invalid: END_BLOCK (format)'],
    ['END_BLOCK with a fraction the column rounds', { endBlock: '200.4' },                   'valid'],
    ['END_BLOCK in the past keeps its verdict',     { endBlock: '99' },                      'invalid: END_BLOCK (must be a future block)'],
    ['END_BLOCK of -1 keeps its verdict',           { endBlock: '-1' },                      'invalid: END_BLOCK (must be a future block)'],
    ['an earlier refusal keeps its verdict over a 23-digit END_BLOCK',
        { endBlock: '10000000000000000000000', options: 'only' },                           'invalid: OPTIONS (need at least 2)'],
    // MAX_SELECTIONS binds raw into SMALLINT UNSIGNED.
    ['MAX_SELECTIONS at the column maximum',        { maxSelections: '65535', options: MANY_OPTIONS }, 'valid'],
    ['MAX_SELECTIONS one past the column maximum',  { maxSelections: '65536', options: MANY_OPTIONS }, 'invalid: MAX_SELECTIONS (format)'],
    ['MAX_SELECTIONS as a hexadecimal literal',     { maxSelections: '0x2' },                'invalid: MAX_SELECTIONS (format)'],
    ['MAX_SELECTIONS of 0 keeps its verdict',       { maxSelections: '0' },                  'invalid: MAX_SELECTIONS (range)'],
    // MIN_VOTERS binds raw into BIGINT UNSIGNED.
    ['MIN_VOTERS at the column maximum',            { minVoters: U64_MAX },                  'valid'],
    ['MIN_VOTERS one past the column maximum',      { minVoters: OVER_U64 },                 'invalid: MIN_VOTERS (format)'],
    ['MIN_VOTERS of 1e30',                          { minVoters: '1e30' },                   'invalid: MIN_VOTERS (format)'],
    ['MIN_VOTERS as a hexadecimal literal',         { minVoters: '0x10' },                   'invalid: MIN_VOTERS (format)'],
    ['MIN_VOTERS in exponent form the column converts', { minVoters: '1e1' },                'valid'],
    ['MIN_VOTERS of 0 on a signaling poll',         Object.assign({ minVoters: '0' }, SIGNALING),  'valid'],
    ['MIN_VOTERS of -1 keeps its verdict',          Object.assign({ minVoters: '-1' }, SIGNALING), 'invalid: MIN_VOTERS (non-negative integer)'],
    // CALLBACK_DELAY_BLOCKS binds as parseInt reads it, so the bound Number is what counts:
    // 2^64-1025 parses to 2^64-2048, while 2^64-1024 and the column maximum parse to 2^64.
    ['CALLBACK_DELAY_BLOCKS of 0',                  { delay: '0' },                          'valid'],
    ['CALLBACK_DELAY_BLOCKS of -1 keeps its verdict', { delay: '-1' },                       'invalid: CALLBACK_DELAY_BLOCKS (non-negative integer)'],
    ['CALLBACK_DELAY_BLOCKS as a hexadecimal literal parseInt reads', { delay: '0x10' },     'valid'],
    ['CALLBACK_DELAY_BLOCKS of 1e30, which parseInt reads as 1', { delay: '1e30' },          'valid'],
    ['CALLBACK_DELAY_BLOCKS whose parsed value is the largest storable', { delay: '18446744073709550591' }, 'valid'],
    ['CALLBACK_DELAY_BLOCKS whose parsed value passes the maximum', { delay: '18446744073709550592' }, 'invalid: CALLBACK_DELAY_BLOCKS (format)'],
    ['CALLBACK_DELAY_BLOCKS at the column maximum, which parseInt rounds past it', { delay: U64_MAX }, 'invalid: CALLBACK_DELAY_BLOCKS (format)'],
    ['CALLBACK_DELAY_BLOCKS that parseInt cannot read', { delay: '.5e1' },                   'invalid: CALLBACK_DELAY_BLOCKS (format)'],
    // The finalize stamps callback_due_block = finalize block + delay in Number, at END_BLOCK
    // at the latest and never past block 2^53, so the delay must leave that stamp below 2^64.
    // Above 2^63 parseInt reads multiples of 2048 and the sum rounds again, so the boundary
    // sits on a rounding midpoint, not at 2^64 - 1 - END_BLOCK: at END_BLOCK 2000,
    // 2^64-3072 parses to 2^64-4096 (stamp 2^64-2048) and 2^64-3071 to 2^64-2048 (stamp 2^64).
    ['CALLBACK_DELAY_BLOCKS whose due block at END_BLOCK is the largest storable',
        { endBlock: '2000', delay: '18446744073709548544' },                                  'valid'],
    ['CALLBACK_DELAY_BLOCKS one past it, whose due block at END_BLOCK passes the maximum',
        { endBlock: '2000', delay: '18446744073709548545' },                                  'invalid: CALLBACK_DELAY_BLOCKS (format)'],
    ['CALLBACK_DELAY_BLOCKS the column stores, whose due block at a live END_BLOCK passes the maximum',
        { endBlock: '900000', delay: '18446744073709550591' },                                'invalid: CALLBACK_DELAY_BLOCKS (format)'],
    // END_BLOCK past 2^53 finalizes at 2^53 at the latest: 2^64-2^53-1025 parses to
    // 2^64-2^53-2048 (stamp 2^64-2048) and 2^64-2^53-1024 to 2^64-2^53 (stamp 2^64).
    ['CALLBACK_DELAY_BLOCKS whose due block at block 2^53, the last the indexer reaches, is the largest storable',
        { endBlock: U64_MAX, delay: '18437736874454809599' },                                 'valid'],
    ['CALLBACK_DELAY_BLOCKS one past it, whose due block at block 2^53 passes the maximum',
        { endBlock: U64_MAX, delay: '18437736874454809600' },                                 'invalid: CALLBACK_DELAY_BLOCKS (format)'],
];

// The rows above that bound callback_due_block, by title prefix.
const DUE_BLOCK_ROWS = VOTE_CASES.filter(([title]) => /whose due block/.test(title));

describe('VOTE v0 refuses a value its poll column cannot store @regression @tier1', function () {
    afterEach(() => sinon.restore());

    for (const [title, overrides, expected] of VOTE_CASES) {
        it(title + ' -> ' + expected, async function () {
            const { status, bound } = await runVoteCreate(voteParams(overrides));
            assert.strictEqual(status, expected);
            assert.ok(bound, 'createPoll wrote no row');
            for (const [column, at] of Object.entries(POLL_COLUMNS))
                assert.ok(columnAccepts('polls', column, bound[at]),
                    'polls.' + column + ' bound ' + String(bound[at]) + ', which its column refuses');
            if (expected !== 'valid')
                assert.strictEqual(bound[2], null, 'a refused create writes the inert row');
        });
    }

    it('a valid create binds END_BLOCK and MIN_VOTERS exactly as the wire carried them', async function () {
        const { status, bound } = await runVoteCreate(voteParams({ endBlock: U64_MAX, minVoters: '1e1' }));
        assert.strictEqual(status, 'valid');
        assert.strictEqual(bound[POLL_COLUMNS.end_block], U64_MAX);
        assert.strictEqual(bound[POLL_COLUMNS.min_voters], '1e1');
    });

    // The verdict is exactly the halting set: the real finalize, run at the last block it can
    // come at with the delay as the column hands it back, stamps a due block the column
    // stores for every valid row and one it refuses for every refused row.
    it('the finalize at the last block a poll can close stamps a storable due block exactly when the create is valid', async function () {
        for (const [title, overrides, expected] of DUE_BLOCK_ROWS) {
            const params = voteParams(overrides);
            const { status, bound } = await runVoteCreate(params);
            assert.strictEqual(status, expected, title);
            // The delay createPoll binds without this refusal, stored and read back.
            const delay = parseInt(params[18]);
            if (expected === 'valid') assert.strictEqual(bound[POLL_COLUMNS.callback_delay_blocks], delay, title);
            const endBlock = mathjs.round(mathjs.bignumber(params[2]));
            const lastClose = Math.min(Number(endBlock), 2 ** 53);
            const { indexer, handler } = freshVote();
            indexer.indexerDb.setPollCallbackDue = sinon.stub().resolves();
            const poll = { action_index: 50, callback_contract_index: 5, callback_on: 'always',
                           callback_delay_blocks: exactU64(String(delay)) };
            await bindingCallback.fireBindingCallback.call(handler, poll, { BLOCK_INDEX: lastClose },
                { poll_status: 'finalized', winning_option: 'yes' });
            assert.ok(indexer.indexerDb.setPollCallbackDue.calledOnce, title + ': no due block stamped');
            const due = indexer.indexerDb.setPollCallbackDue.firstCall.args[1];
            assert.strictEqual(columnAccepts('polls', 'callback_due_block', `${due}`), expected === 'valid',
                title + ': stamped ' + `${due}`);
        }
    });
});

// ── ATTEST v0 ─────────────────────────────────────────────────────────────────

function makeDb(){
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config: getTestConfig(), util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => { calls.push({ sql, args }); return []; });
    sinon.stub(db, 'createStatus').resolves(9);
    sinon.stub(db, 'getAddressId').resolves(4);
    sinon.stub(db, 'createTicker').resolves(2);
    sinon.stub(db, 'createAddress').resolves(3);
    sinon.stub(db, 'createMemo').resolves(null);
    return { db, calls };
}

function insertArgs(calls, table){
    const insert = calls.find(c => new RegExp('INSERT INTO ' + table + '\\b').test(c.sql));
    assert.ok(insert, 'no INSERT INTO ' + table);
    return insert.args;
}

// attests INSERT order: action_index, request_id, contract_index, fee_payer_id, provider_id,
// payload, callback_method, callback_params_json, redundancy, deadline_block, ...
const ATTEST_REDUNDANCY = 8, ATTEST_DEADLINE = 9;

const ATTEST_ROWS = [
    // [title, REDUNDANCY wire, DEADLINE_BLOCK, bound redundancy, bound deadline_block]
    ['a valid request binds its values unchanged', '3', 150, 3, 150],
    ['the column maxima bind unchanged', '255', Number.MAX_SAFE_INTEGER, 255, Number.MAX_SAFE_INTEGER],
    ['redundancy 256 and a deadline past 2^64 bind the column maxima', '256', 1e22, '255', U64_MAX],
    ['redundancy -1 and a negative deadline bind 0', '-1', -899, '0', '0'],
    ['redundancy 1e30 binds the column maximum', '1e30', 150, '255', 150],
    ['redundancy Infinity, which binds unquoted, binds 0', 'Infinity', 150, 0, 150],
];

describe('ATTEST v0 request rows bind only what their columns store @regression @tier1', function () {
    afterEach(() => sinon.restore());

    for (const [title, redundancy, deadline, wantRedundancy, wantDeadline] of ATTEST_ROWS) {
        it(title, async function () {
            const { db, calls } = makeDb();
            await db.createAttestationRequest({
                ACTION: 'ATTEST', ACTION_INDEX: 70, BLOCK_INDEX: 100, REQUEST_ID: 'ab'.repeat(32),
                PROVIDER_ID: 'http_get', CALLBACK_METHOD: 'onResult', REDUNDANCY: redundancy,
                DEADLINE_BLOCK: deadline, STATUS: 'invalid: ATTEST v0 must originate from VM emission',
                REQUEST_STATUS: 'rejected', SOURCE: 'src'
            });
            const args = insertArgs(calls, 'attests');
            assert.strictEqual(args[ATTEST_REDUNDANCY], wantRedundancy);
            assert.strictEqual(args[ATTEST_DEADLINE], wantDeadline);
            assert.ok(columnAccepts('attests', 'redundancy', args[ATTEST_REDUNDANCY]));
            assert.ok(columnAccepts('attests', 'deadline_block', args[ATTEST_DEADLINE]));
        });
    }

    it('a user-broadcast v0 with out-of-range fields keeps its verdict and never enters the pending pool', async function () {
        const { indexer, handler } = setUpAttestHandler();
        const data = v0Data({ IS_EMISSION: false });
        await handler.parse(v0Params({ redundancy: '300', deadline: '-999' }), data, null);
        assert.strictEqual(data.STATUS, 'invalid: ATTEST v0 must originate from VM emission');
        assert.strictEqual(data.REQUEST_STATUS, 'rejected');
        assert.ok(indexer.indexerDb.createAttestationRequest.calledOnce);
    });
});

// ── ISSUE|7 MIN_DEPTH ─────────────────────────────────────────────────────────

const { run, format7, tokenRow } = issueFixtures;

const ISSUE_CASES = [
    ['MIN_DEPTH of 15 digits, the column width', '999999999999999',  'valid'],
    ['MIN_DEPTH of 16 digits',                   '1000000000000000', 'invalid: MIN_DEPTH (format)'],
    ['MIN_DEPTH of 16 characters with leading zeros', '0000000000000003', 'invalid: MIN_DEPTH (format)'],
    ['MIN_DEPTH of 0',                           '0',                'valid'],
    ['MIN_DEPTH of 3.5 keeps its verdict',       '3.5',              'invalid: MIN_DEPTH (format)'],
];

describe('ISSUE|7 refuses a MIN_DEPTH its columns cannot store @regression @tier1', function () {
    afterEach(() => sinon.restore());

    for (const [title, minDepth, expected] of ISSUE_CASES) {
        it(title + ' -> ' + expected, async function () {
            const { status, indexer } = await run({ params: format7({ BRIDGE_CHAINS: 'DOGE', MIN_DEPTH: minDepth }), token: tokenRow() });
            assert.strictEqual(status, expected);
            const issue = indexer.indexerDb.createIssue.firstCall.args[0];
            const { db, calls } = makeDb();
            await db.createIssue(Object.assign({}, issue));
            const bound = insertArgs(calls, 'issues')[24];
            assert.ok(columnAccepts('issues', 'min_depth', bound), 'issues.min_depth bound ' + bound);
            if (expected === 'valid')
                assert.strictEqual(bound, minDepth, 'a valid ISSUE|7 stores the wire text unchanged');
        });
    }

    it('a refused ISSUE|7 with a 40-character MIN_DEPTH writes its row', async function () {
        const { db, calls } = makeDb();
        await db.createIssue({ ACTION: 'ISSUE', ACTION_INDEX: 80, TICK: 'FUFU', MIN_DEPTH: 'x'.repeat(40),
                               STATUS: 'invalid: MIN_DEPTH (format)' });
        // A refused row is clipped to the VARCHAR(15) column, never read back.
        assert.strictEqual(insertArgs(calls, 'issues')[24], 'x'.repeat(15));
    });
});

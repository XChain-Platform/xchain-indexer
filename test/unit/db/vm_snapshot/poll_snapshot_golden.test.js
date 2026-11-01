'use strict';

// Golden bytes of the poll VM snapshot. Every snapshot is compared as a literal
// JSON.stringify string so the key order is pinned along with the values.

const assert = require('assert');

const pollMethods = require('../../../../src/db/polls/vm_snapshot.js');
const { isNull } = require('../../../../src/utility/validation/value_checks.js');

const BOUND = 100;

const POLL_ROWS = [
    { action_index: 7, poll_status: 'finalized', winning_option: 2, total_weight: 1500, total_voters: 3, decided_early: 1, tick: 'XCP' },
    { action_index: 12, poll_status: 'failed_quorum', winning_option: null, total_weight: null, total_voters: null, decided_early: 0, tick: null },
    { action_index: 20, poll_status: 'finalized', winning_option: 0, total_weight: 0, total_voters: 0, decided_early: 0, tick: 'PEPE' }
];

// Deliberately not in ascending option order, and one row for a poll outside the set.
const OPTION_ROWS = [
    { poll_index: 7, option_index: 2, total_weight: 900, voter_count: 2 },
    { poll_index: 7, option_index: 1, total_weight: 600, voter_count: 1 },
    { poll_index: 99, option_index: 0, total_weight: 5, voter_count: 1 }
];

function makeDb(pollRows, optionRows){
    const calls = [];
    const doQuery = async (sql, params) => {
        calls.push({ sql, params });
        if(sql.includes('FROM poll_results'))
            return optionRows;
        if(sql.includes('FROM polls p'))
            return pollRows;
        throw new Error('unexpected query: ' + sql);
    };
    // No _vmSnapshotMemo: the getter must build fresh through this.buildPollResultsForVM.
    const db = Object.assign({}, pollMethods, { doQuery, util: { isNull } });
    return { db, calls };
}

describe('poll VM snapshot golden bytes', function () {
    it('includeTick false carries no tick key', async function () {
        const { db } = makeDb(POLL_ROWS, OPTION_ROWS);
        const snap = await db.buildPollResultsForVM(BOUND, false);
        assert.strictEqual(JSON.stringify(snap),
            '{"polls":{'
            + '"7":{"status":"finalized","winning_option":2,"total_weight":"1500","total_voters":3,"decided_early":true,'
            + '"options":[{"index":2,"weight":"900","voters":2},{"index":1,"weight":"600","voters":1}]},'
            + '"12":{"status":"failed_quorum","winning_option":null,"total_weight":null,"total_voters":null,"decided_early":false,"options":[]},'
            + '"20":{"status":"finalized","winning_option":0,"total_weight":"0","total_voters":0,"decided_early":false,"options":[]}'
            + '}}');
    });

    it('includeTick true appends a tick key, null when the joined tick is null', async function () {
        const { db } = makeDb(POLL_ROWS, OPTION_ROWS);
        const snap = await db.buildPollResultsForVM(BOUND, true);
        assert.strictEqual(JSON.stringify(snap),
            '{"polls":{'
            + '"7":{"status":"finalized","winning_option":2,"total_weight":"1500","total_voters":3,"decided_early":true,'
            + '"options":[{"index":2,"weight":"900","voters":2},{"index":1,"weight":"600","voters":1}],"tick":"XCP"},'
            + '"12":{"status":"failed_quorum","winning_option":null,"total_weight":null,"total_voters":null,"decided_early":false,"options":[],"tick":null},'
            + '"20":{"status":"finalized","winning_option":0,"total_weight":"0","total_voters":0,"decided_early":false,"options":[],"tick":"PEPE"}'
            + '}}');
    });

    it('a finalized poll with no option rows yields options []', async function () {
        const { db } = makeDb([POLL_ROWS[2]], []);
        const snap = await db.buildPollResultsForVM(BOUND, false);
        assert.strictEqual(JSON.stringify(snap),
            '{"polls":{"20":{"status":"finalized","winning_option":0,"total_weight":"0","total_voters":0,"decided_early":false,"options":[]}}}');
    });

    it('a failed_quorum poll keeps null winning_option, total_weight and total_voters', async function () {
        const { db } = makeDb([POLL_ROWS[1]], []);
        const snap = await db.buildPollResultsForVM(BOUND, false);
        assert.strictEqual(JSON.stringify(snap),
            '{"polls":{"12":{"status":"failed_quorum","winning_option":null,"total_weight":null,"total_voters":null,"decided_early":false,"options":[]}}}');
    });

    it('decided_early maps 0 to false and 1 to true', async function () {
        const rows = [
            { action_index: 1, poll_status: 'finalized', winning_option: 1, total_weight: 10, total_voters: 1, decided_early: 0, tick: null },
            { action_index: 2, poll_status: 'finalized', winning_option: 1, total_weight: 10, total_voters: 1, decided_early: 1, tick: null }
        ];
        const { db } = makeDb(rows, []);
        const snap = await db.buildPollResultsForVM(BOUND, false);
        assert.strictEqual(JSON.stringify(snap),
            '{"polls":{'
            + '"1":{"status":"finalized","winning_option":1,"total_weight":"10","total_voters":1,"decided_early":false,"options":[]},'
            + '"2":{"status":"finalized","winning_option":1,"total_weight":"10","total_voters":1,"decided_early":true,"options":[]}'
            + '}}');
    });

    it('numeric poll and option indexes key and group as strings', async function () {
        const { db } = makeDb([POLL_ROWS[0]], [
            { poll_index: 7, option_index: 3, total_weight: 1, voter_count: 1 },
            { poll_index: 7, option_index: 0, total_weight: 2, voter_count: 2 }
        ]);
        const snap = await db.buildPollResultsForVM(BOUND, false);
        assert.deepStrictEqual(Object.keys(snap.polls), ['7']);
        assert.strictEqual(JSON.stringify(snap.polls['7'].options),
            '[{"index":3,"weight":"1","voters":1},{"index":0,"weight":"2","voters":2}]');
    });

    it('an empty finalized set returns an empty polls map without the options read', async function () {
        const { db, calls } = makeDb([], OPTION_ROWS);
        const snap = await db.buildPollResultsForVM(BOUND, false);
        assert.strictEqual(JSON.stringify(snap), '{"polls":{}}');
        assert.strictEqual(calls.length, 1);
        assert.ok(!calls.some((c) => c.sql.includes('poll_results')));
    });

    it('both reads receive [bound]', async function () {
        const { db, calls } = makeDb(POLL_ROWS, OPTION_ROWS);
        await db.buildPollResultsForVM(BOUND, false);
        assert.strictEqual(calls.length, 2);
        assert.ok(calls[0].sql.includes('FROM polls p'));
        assert.ok(calls[1].sql.includes('FROM poll_results'));
        // Pin the polls read's total order (snapshot key order must not rest on engine row order).
        assert.match(calls[0].sql, /ORDER BY p\.action_index ASC\s*$/);
        assert.deepStrictEqual(calls[0].params, [BOUND]);
        assert.deepStrictEqual(calls[1].params, [BOUND]);
    });

    it('getPollResultsForVM returns the same bytes as the builder', async function () {
        for(const includeTick of [false, true]){
            const built = makeDb(POLL_ROWS, OPTION_ROWS);
            const got = makeDb(POLL_ROWS, OPTION_ROWS);
            const expected = JSON.stringify(await built.db.buildPollResultsForVM(BOUND, includeTick));
            const actual = JSON.stringify(await got.db.getPollResultsForVM(BOUND, includeTick));
            assert.strictEqual(actual, expected);
            assert.deepStrictEqual(got.calls.map((c) => c.params), [[BOUND], [BOUND]]);
        }
    });
});

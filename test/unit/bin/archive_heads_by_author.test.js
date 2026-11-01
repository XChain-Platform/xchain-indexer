/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const { ARCHIVE_REISSUE_RETRY_REASON } =
    require('../../../src/actions/anchor/archive/archive_reissue.js');
const {
    parseArgs, archiveHeadsQuery, summarize, exitCodeFor, conflicts, conflictExitCode,
    readHeads, render,
} = require('../../../bin/archive_heads_by_author.js');

const heads = [
    {
        action_index: 40, version: 3, match_batch_seq: 4,
        batch_crc32: 'aaaa', match_count: 2, block_index_doge: 100,
        status: 'valid'
    },
    {
        action_index: 41, version: 3, match_batch_seq: '4',
        batch_crc32: 'bbbb', match_count: 3, block_index_doge: 101,
        status: ARCHIVE_REISSUE_RETRY_REASON
    },
    {
        action_index: 50, version: 3, match_batch_seq: 5,
        batch_crc32: 'cccc', match_count: 4, block_index_doge: 102,
        status: 'valid'
    },
];

describe('bin/archive_heads_by_author', function () {
    it('parses the required author and optional filters', function () {
        assert.deepStrictEqual(parseArgs(['--author', 'A']), {
            author: 'A', fromSeq: null, limit: 50, db: null, json: false,
            expectRedrawn: false, expectConflict: false
        });
        assert.deepStrictEqual(
            parseArgs([
                '--author', 'A', '--from-seq', '0', '--limit', '7', '--db', 'x', '--json',
                '--expect-redrawn', '--expect-conflict'
            ]),
            {
                author: 'A', fromSeq: 0, limit: 7, db: 'x', json: true,
                expectRedrawn: true, expectConflict: true
            });
    });

    it('rejects missing and invalid arguments', function () {
        assert.throws(() => parseArgs([]), /--author is required/);
        assert.throws(() => parseArgs(['--author']), /--author needs a value/);
        assert.throws(() => parseArgs(['--author', 'A', '--from-seq', '']), /non-negative integer/);
        assert.throws(() => parseArgs(['--author', 'A', '--from-seq', '-1']), /non-negative integer/);
        assert.throws(() => parseArgs(['--author', 'A', '--from-seq', '1.5']), /non-negative integer/);
        assert.throws(() => parseArgs(['--author', 'A', '--limit', '0']), /positive integer/);
        assert.throws(() => parseArgs(['--author', 'A', '--other']), /unknown argument/);
    });

    it('builds an all-status query without a from-seq filter', function () {
        const query = archiveHeadsQuery({ author: 'A', fromSeq: null, limit: 5 });
        assert.deepStrictEqual(query.args, ['A', 5]);
        assert.match(query.sql, /^SELECT /);
        assert.match(query.sql, /FROM anchor_actions a/);
        assert.match(query.sql, /JOIN index_statuses s\s+ON s\.id = a\.status_id/);
        assert.match(query.sql, /JOIN actions act\s+ON act\.action_index = a\.action_index/);
        assert.match(query.sql, /JOIN index_addresses adr ON adr\.id = act\.source_id/);
        assert.match(query.sql, /a\.version <> 2/);
        assert.match(query.sql, /a\.match_batch_seq IS NOT NULL/);
        assert.match(query.sql, /adr\.address = \?/);
        assert.doesNotMatch(query.sql, /status\s+IN/i);
        assert.doesNotMatch(query.sql, /match_batch_seq >= \?/);
        assert.match(query.sql, /ORDER BY a\.match_batch_seq, a\.action_index/);
        assert.match(query.sql, /LIMIT \?$/);
    });

    it('adds the from-seq filter and argument before the limit', function () {
        const query = archiveHeadsQuery({ author: 'A', fromSeq: 4, limit: 6 });
        assert.deepStrictEqual(query.args, ['A', 4, 6]);
        assert.match(query.sql, /a\.match_batch_seq >= \?/);
        assert.doesNotMatch(query.sql, /status\s+IN/i);
    });

    it('reads through doQueryStrict and returns rows with their summary', async function () {
        const calls = [];
        const db = {
            async doQueryStrict(sql, args) {
                calls.push({ sql, args });
                return heads;
            }
        };
        const result = await readHeads(db, { author: 'A', fromSeq: 4, limit: 10 });
        assert.strictEqual(calls.length, 1);
        assert.match(calls[0].sql.trim(), /^SELECT/);
        assert.deepStrictEqual(calls[0].args, ['A', 4, 10]);
        assert.strictEqual(result.author, 'A');
        assert.strictEqual(result.rows, heads);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'conflict'), false);
        assert.deepStrictEqual(result.summary, {
            count: 3, seqs: 2, refused: 1, refusedSeqs: [4],
            maxValidSeq: 5, redrawnAbove: true
        });
    });

    it('requires a valid head above every refused sequence for redrawn-above', function () {
        assert.strictEqual(summarize(heads.slice(0, 2)).redrawnAbove, false);
        const multiple = heads.concat([{
            match_batch_seq: 6, status: ARCHIVE_REISSUE_RETRY_REASON
        }]);
        assert.strictEqual(summarize(multiple).redrawnAbove, false);
    });

    it('maps the redraw expectation and summary to an exit code', function () {
        const redrawn = summarize(heads);
        const notRedrawn = summarize(heads.slice(0, 2));
        const noRefusal = summarize(heads.slice(0, 1));
        const off = { expectRedrawn: false };
        const on = { expectRedrawn: true };

        assert.strictEqual(exitCodeFor(redrawn, off), 0);
        assert.strictEqual(exitCodeFor(notRedrawn, off), 0);
        assert.strictEqual(exitCodeFor(noRefusal, off), 0);
        assert.strictEqual(exitCodeFor(noRefusal, on), 1);
        assert.strictEqual(exitCodeFor(notRedrawn, on), 1);
        assert.strictEqual(exitCodeFor(redrawn, on), 0);
    });

    it('confirms refused heads only from earlier conflicting content at the same seq', function () {
        const duplicate = {
            action_index: 42, match_batch_seq: 4, batch_crc32: 'AAAA', match_count: 2,
            status: ARCHIVE_REISSUE_RETRY_REASON
        };
        const fresh = {
            action_index: 43, match_batch_seq: 9, batch_crc32: 'dddd', match_count: 1,
            status: ARCHIVE_REISSUE_RETRY_REASON
        };
        const lateValid = {
            action_index: 50, match_batch_seq: 10, batch_crc32: 'eeee', match_count: 2,
            status: 'valid'
        };
        const beforeLate = {
            action_index: 44, match_batch_seq: 10, batch_crc32: 'ffff', match_count: 3,
            status: ARCHIVE_REISSUE_RETRY_REASON
        };

        assert.deepStrictEqual(conflicts(heads.slice(0, 2)), {
            refused: 1, confirmed: 1, unexplained: 0, unexplainedActions: []
        });
        assert.deepStrictEqual(conflicts(heads.slice(0, 2).concat([duplicate, fresh])), {
            refused: 3, confirmed: 1, unexplained: 2, unexplainedActions: [42, 43]
        });
        assert.deepStrictEqual(conflicts([beforeLate, lateValid]), {
            refused: 1, confirmed: 0, unexplained: 1, unexplainedActions: [44]
        });
    });

    it('accepts an earlier unverified head as conflict evidence', function () {
        const rows = [{
            action_index: 10, match_batch_seq: '7', batch_crc32: 'aaaa', match_count: 2,
            status: 'unverified'
        }, {
            action_index: '11', match_batch_seq: 7, batch_crc32: 'bbbb', match_count: 2,
            status: ARCHIVE_REISSUE_RETRY_REASON
        }];

        assert.deepStrictEqual(conflicts(rows), {
            refused: 1, confirmed: 1, unexplained: 0, unexplainedActions: []
        });
    });

    it('maps the conflict expectation and evidence to an exit code', function () {
        const confirmed = conflicts(heads.slice(0, 2));
        const unexplained = conflicts([heads[1]]);
        const none = conflicts([heads[0]]);
        const off = { expectConflict: false };
        const on = { expectConflict: true };

        assert.strictEqual(conflictExitCode(undefined, off), 0);
        assert.strictEqual(conflictExitCode(confirmed, off), 0);
        assert.strictEqual(conflictExitCode(unexplained, off), 0);
        assert.strictEqual(conflictExitCode(undefined, on), 1);
        assert.strictEqual(conflictExitCode(none, on), 1);
        assert.strictEqual(conflictExitCode(unexplained, on), 1);
        assert.strictEqual(conflictExitCode(confirmed, on), 0);
    });

    it('adds conflict evidence to read results only when requested', async function () {
        const db = { doQueryStrict: async () => heads.slice(0, 2) };
        const opts = { author: 'A', fromSeq: null, limit: 5, expectConflict: false };

        const ordinary = await readHeads(db, opts);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(ordinary, 'conflict'), false);
        const expected = await readHeads(db, { ...opts, expectConflict: true });
        assert.deepStrictEqual(expected.conflict, {
            refused: 1, confirmed: 1, unexplained: 0, unexplainedActions: []
        });
    });

    it('does not count another invalid status as refused', function () {
        const summary = summarize([{ match_batch_seq: 8, status: 'invalid: another reason' }]);
        assert.deepStrictEqual(summary, {
            count: 1, seqs: 1, refused: 0, refusedSeqs: [],
            maxValidSeq: null, redrawnAbove: false
        });
    });

    it('summarizes no rows', function () {
        assert.deepStrictEqual(summarize([]), {
            count: 0, seqs: 0, refused: 0, refusedSeqs: [],
            maxValidSeq: null, redrawnAbove: false
        });
    });

    it('renders every head followed by the summary', function () {
        const result = { author: 'A', rows: heads, summary: summarize(heads) };
        assert.strictEqual(render(result, false), [
            'seq=4 action-index=40 version=3 crc32=aaaa matches=2 block=100 status=valid',
            'seq=4 action-index=41 version=3 crc32=bbbb matches=3 block=101 status=' +
                ARCHIVE_REISSUE_RETRY_REASON,
            'seq=5 action-index=50 version=3 crc32=cccc matches=4 block=102 status=valid',
            '# heads=3 seqs=2 refused=1 max-valid-seq=5 redrawn-above=yes'
        ].join('\n'));
        assert.strictEqual(
            render({ author: 'A', rows: heads.slice(0, 2), summary: summarize(heads.slice(0, 2)) }, false)
                .split('\n').pop(),
            '# heads=2 seqs=1 refused=1 max-valid-seq=4 redrawn-above=no');
    });

    it('appends conflict evidence only when present', function () {
        const result = {
            author: 'A', rows: heads.slice(0, 2), summary: summarize(heads.slice(0, 2)),
            conflict: conflicts(heads.slice(0, 2))
        };

        assert.strictEqual(
            render(result, false).split('\n').pop(),
            '# conflict refused=1 confirmed=1 unexplained=0');
        const ordinary = { author: result.author, rows: result.rows, summary: result.summary };
        assert.strictEqual(render(ordinary, false).includes('# conflict'), false);
    });

    it('renders the complete result as JSON', function () {
        const result = { author: 'A', rows: heads, summary: summarize(heads) };
        assert.deepStrictEqual(JSON.parse(render(result, true)), result);
    });
});

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
    parseArgs, archiveHeadsQuery, summarize, readHeads, render,
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
            author: 'A', fromSeq: null, limit: 50, db: null, json: false
        });
        assert.deepStrictEqual(
            parseArgs(['--author', 'A', '--from-seq', '0', '--limit', '7', '--db', 'x', '--json']),
            { author: 'A', fromSeq: 0, limit: 7, db: 'x', json: true });
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

    it('renders the complete result as JSON', function () {
        const result = { author: 'A', rows: heads, summary: summarize(heads) };
        assert.deepStrictEqual(JSON.parse(render(result, true)), result);
    });
});

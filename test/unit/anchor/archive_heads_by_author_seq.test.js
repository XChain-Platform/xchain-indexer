'use strict';

const assert = require('assert');
const sinon = require('sinon');

const mirrorReads = require('../../../src/db/database/mirror_reads.js');

const AUTHOR = 'DPublisher';
const BATCH_SEQ = '7';

async function readHeads(rows) {
    const doQuery = sinon.stub().resolves(rows);
    const db = { doQuery };
    const value = await mirrorReads.getArchiveHeadsByAuthorAndSeq.call(db, AUTHOR, BATCH_SEQ);
    return { value, query: doQuery.firstCall.args[0], params: doQuery.firstCall.args[1] };
}

describe('getArchiveHeadsByAuthorAndSeq()', function () {
    afterEach(function () { sinon.restore(); });

    it('queries with the author-and-seq params', async function () {
        const result = await readHeads([]);
        assert.deepStrictEqual(result.params, [7, AUTHOR]);
        assert.match(result.query, /a\.match_batch_seq = \?/);
        assert.match(result.query, /a\.version <> 2/);
        assert.match(result.query, /s\.status IN \('valid', 'unverified'\)/);
        assert.match(result.query, /adr\.address = \?/);
    });

    it('returns the stubbed rows unchanged', async function () {
        const rows = [
            { batch_crc32: 'deadbeef', match_count: 4, status: 'valid' },
            { batch_crc32: 'cafebabe', match_count: 2, status: 'unverified' }
        ];
        const result = await readHeads(rows);
        assert.deepStrictEqual(result.value, rows);
    });

    it('returns an empty array when no row matches', async function () {
        const result = await readHeads(null);
        assert.deepStrictEqual(result.value, []);
    });
});

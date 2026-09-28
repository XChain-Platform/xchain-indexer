'use strict';

const assert = require('assert');

const mirrorReads = require('../../../../src/db/database/mirror_reads.js');
const { archiveHeadPredicate } = require('../../../../src/consensus/state_hash.js');

describe('getMaxArchiveBatchSeqByAuthor archive-head predicate', function () {
    it('uses the shared archive-head predicate without an executable v1-only comparison', async function () {
        let captured;
        const doQuery = async function (sql, args) {
            captured = { sql, args };
            return [];
        };

        await mirrorReads.getMaxArchiveBatchSeqByAuthor.call({ doQuery }, 'DPublisher');

        const executableSql = captured.sql.replace(/\/\*[\s\S]*?\*\//g, '');
        assert.ok(executableSql.includes(archiveHeadPredicate('a')));
        assert.doesNotMatch(executableSql, /\ba\.version\s*=\s*1\b/);
        assert.deepStrictEqual(captured.args, ['DPublisher']);
    });
});

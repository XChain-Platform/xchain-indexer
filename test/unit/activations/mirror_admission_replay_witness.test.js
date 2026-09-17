'use strict';

const assert = require('assert');
const { queryIndexerDb } = require('../../../bin/verify-mirror-admission-replay-equivalence.js');

describe('mirror-admission replay witness', function () {
    it('runs parameterized SQL through the indexer Database wrapper', async function () {
        const calls = [];
        const indexerDb = Object.create({
            async doQuery(sql, args) {
                calls.push({ sql, args });
                return [{ block_index: 7 }];
            },
        });
        const sql = 'SELECT block_index FROM blocks WHERE block_index = ?';
        const args = [7];

        const rows = await queryIndexerDb(indexerDb)(sql, args);

        assert.deepStrictEqual(rows, [{ block_index: 7 }]);
        assert.deepStrictEqual(calls, [{ sql, args }]);
        assert.strictEqual(indexerDb.query, undefined);
    });
});

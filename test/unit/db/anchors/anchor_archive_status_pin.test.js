'use strict';

const assert = require('assert');

const anchors = require('../../../../src/db/anchors/index.js');

describe('setAnchorArchiveStatus()', function () {
    it('updates every row for the action with the requested status', async function () {
        const statuses = [];
        const queries = [];
        const stub = {
            async createStatus(status) {
                statuses.push(status);
                return 7;
            },
            async doQuery(sql, args) {
                queries.push({ sql, args });
                return [];
            }
        };

        await anchors.setAnchorArchiveStatus.call(stub, 42, 'invalid_archive');

        assert.deepStrictEqual(statuses, ['invalid_archive']);
        assert.strictEqual(queries.length, 1);
        assert.strictEqual(queries[0].sql,
            'UPDATE anchor_actions SET status_id = ? WHERE action_index = ?');
        assert.deepStrictEqual(queries[0].args, [7, 42]);
        assert.ok(!/version/i.test(queries[0].sql));
        assert.ok(!/match_batch_seq/i.test(queries[0].sql));
    });
});

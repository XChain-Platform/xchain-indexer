'use strict';

const assert = require('assert');

const anchors = require('../../../../src/db/anchors/index.js');
const { archiveHeadPredicate } = require('../../../../src/consensus/state_hash.js');

describe('anchor archive status helpers', function () {
    it('keeps the action-wide update and scopes the row update to the archive head', async function () {
        const statuses = [];
        const queries = [];
        const stub = {
            async createStatus(status) {
                statuses.push(status);
                return statuses.length + 6;
            },
            async doQuery(sql, args) {
                queries.push({ sql, args });
                return [];
            }
        };

        await anchors.setAnchorArchiveStatus.call(stub, 42, 'invalid_archive');
        await anchors.setAnchorArchiveRowStatus.call(stub, 43, 'valid');

        assert.deepStrictEqual(statuses, ['invalid_archive', 'valid']);
        assert.deepStrictEqual(queries, [
            {
                sql: 'UPDATE anchor_actions SET status_id = ? WHERE action_index = ?',
                args: [7, 42]
            },
            {
                sql: 'UPDATE anchor_actions a SET a.status_id = ? WHERE a.action_index = ? AND ' +
                    archiveHeadPredicate('a'),
                args: [8, 43]
            }
        ]);
    });
});

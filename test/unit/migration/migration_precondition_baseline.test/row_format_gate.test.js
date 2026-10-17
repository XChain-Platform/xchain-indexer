'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

const assert = require('assert');
const { statementsOf } = require('../migration_runner.test/helpers/migration_fixtures.js');
const { assertNoLiveColumnLoss } = require('../../../../src/db/database/migration_live_schema_guard.js');

const SQL = 'ALTER TABLE files MODIFY name VARCHAR(250) CHARACTER SET utf8mb4;';
const liveRow = (over) => Object.assign({
    COLUMN_TYPE: 'varchar(250)', COLUMN_DEFAULT: null, EXTRA: '', COLUMN_COMMENT: '',
    GENERATION_EXPRESSION: '', CHARACTER_SET_NAME: 'utf8', COLLATION_NAME: 'utf8_general_ci',
    TABLE_COLLATION: 'utf8_general_ci', ROW_FORMAT: 'Compact',
}, over);

async function verdict(over, options = {}){
    const seen = [];
    const conn = { query: async (text, params) => {
        seen.push({ text, params });
        if(/information_schema\.COLUMNS/i.test(text)) return [liveRow(over)];
        if(/information_schema\.STATISTICS/i.test(text)) return options.indexed === false ? [] : [{ indexed: 1 }];
        throw new Error('unexpected query: ' + text);
    } };
    try {
        await assertNoLiveColumnLoss(conn, '2026-08-19-utf8mb4-user-text-columns.sql', statementsOf(options.sql || SQL));
        return { error: null, seen };
    } catch(error){
        return { error, seen };
    }
}

describe('migration live-schema MODIFY guard: row format gate @regression @tier1', function () {
    it('refuses the indexed files.name utf8mb4 widening on Compact', async function () {
        const got = await verdict();
        assert.strictEqual(got.error.name, 'MigrationRowFormatError');
        assert.match(got.error.message,
            /^runMigrations: 2026-08-19-utf8mb4-user-text-columns\.sql widens files\.name to utf8mb4 on a Compact table where the column is indexed/);
        assert.match(got.error.message, /Run ALTER TABLE files ROW_FORMAT=DYNAMIC; and restart, or re-tag the file `-- xchain:migration mode=manual` and apply it deliberately via `node src\/db\/migration\/migrate\.js`\.$/);
        const indexRead = got.seen.find(q => /information_schema\.STATISTICS/i.test(q.text));
        assert.deepStrictEqual(indexRead.params, ['files', 'name']);
        assert.match(indexRead.text, /SUB_PART IS NULL/);
    });

    it('also refuses Redundant row format', async function () {
        const got = await verdict({ ROW_FORMAT: 'Redundant' });
        assert.strictEqual(got.error.name, 'MigrationRowFormatError');
        assert.match(got.error.message, /on a Redundant table/);
    });

    it('passes Dynamic row format', async function () {
        const got = await verdict({ ROW_FORMAT: 'Dynamic' });
        assert.strictEqual(got.error, null);
        assert.strictEqual(got.seen.length, 1);
    });

    it('passes Compact when the column is not fully indexed', async function () {
        const got = await verdict({}, { indexed: false });
        assert.strictEqual(got.error, null);
    });

    it('passes a 100-character utf8mb4 widening that fits within 767 bytes', async function () {
        const got = await verdict({ COLUMN_TYPE: 'varchar(100)' }, {
            sql: 'ALTER TABLE files MODIFY name VARCHAR(100) CHARACTER SET utf8mb4;',
        });
        assert.strictEqual(got.error, null);
        assert.strictEqual(got.seen.length, 1);
    });

    it('passes when the live column is already utf8mb4', async function () {
        const got = await verdict({ CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_general_ci' });
        assert.strictEqual(got.error, null);
        assert.strictEqual(got.seen.length, 1);
    });

    it('treats a missing row format as Dynamic', async function () {
        const got = await verdict({ ROW_FORMAT: undefined });
        assert.strictEqual(got.error, null);
        assert.strictEqual(got.seen.length, 1);
    });
});

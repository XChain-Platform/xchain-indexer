'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Live-schema MODIFY guard, type and charset rules: a type change with no widening rule
 * fails closed, a same-name restatement may not drop precision, and a text MODIFY that
 * names no charset or collation may not fall back to a different table default.
 *
 ********************************************************************/

const { assert, statementsOf } = require('./helpers/migration_fixtures.js');
const { assertNoLiveColumnLoss, losses } = require('../../../../src/db/database/migration_live_schema_guard.js');

const liveRow = (over) => Object.assign({
    COLUMN_TYPE: 'bigint(20) unsigned', COLUMN_DEFAULT: null, EXTRA: '', COLUMN_COMMENT: '',
    GENERATION_EXPRESSION: '', CHARACTER_SET_NAME: null, COLLATION_NAME: null, TABLE_COLLATION: null,
}, over);
const lossOf = (over, definition) => losses(liveRow(over), definition).join('; ');
const text = (type, set, collation, table) =>
    ({ COLUMN_TYPE: type, CHARACTER_SET_NAME: set, COLLATION_NAME: collation, TABLE_COLLATION: table });

describe('migration live-schema MODIFY guard: type changes @regression @tier1', function () {
    it('refuses a type change it has no widening rule for', function () {
        for (const [live, next] of [
            ['decimal(8,4)', 'INT'], ['datetime', 'DATE'], ['timestamp', 'DATE'], ['double', 'FLOAT'],
            ['double', 'INT'], ['date', 'TIME'], ['datetime', 'TIMESTAMP'], ["enum('a','b')", 'VARCHAR(10)'],
            ['varchar(250)', 'TINYTEXT'], ['bigint(20)', 'DECIMAL(5,2)'], ['int(11)', 'DECIMAL(12,4)'],
            ['bigint(20) unsigned', 'DECIMAL(19,0)'], ['int(11)', 'DECIMAL(10,0) UNSIGNED'],
        ]) assert.match(lossOf({ COLUMN_TYPE: live }, next), /narrows the type/, live + ' -> ' + next);
    });

    it('refuses a same-name restatement that drops precision, fractional seconds or width', function () {
        for (const [live, next] of [
            ['decimal(20,8)', 'DECIMAL'], ['datetime(6)', 'DATETIME'], ['timestamp(3)', 'TIMESTAMP'],
            ['time(6)', 'TIME'], ['bit(8)', 'BIT(4)'], ['double(20,8)', 'DOUBLE(10,2)'], ['float', 'FLOAT(7,4)'],
            ['decimal(10,2)', 'DECIMAL(10,2) UNSIGNED'],
        ]) assert.match(lossOf({ COLUMN_TYPE: live }, next), /narrows the type/, live + ' -> ' + next);
    });

    it('passes widenings and alias restatements', function () {
        for (const [live, next] of [
            ['timestamp(3)', 'DATETIME(6)'], ['date', 'DATETIME'], ['int(11)', 'DECIMAL(10,0)'],
            ['bigint(20) unsigned', 'DECIMAL(20,0) UNSIGNED'], ['decimal(8,4)', 'DECIMAL(10,4)'],
            ['decimal(8,4)', 'NUMERIC(8,4)'], ['decimal(10,0)', 'DECIMAL'], ['float', 'DOUBLE'],
            ['datetime(6)', 'DATETIME(6)'], ['tinyint(1)', 'BOOLEAN'], ['longtext', 'JSON'], ['varchar(250)', 'TEXT'],
        ]) assert.strictEqual(lossOf({ COLUMN_TYPE: live }, next), '', live + ' -> ' + next);
    });

    it('names the live and restated types when a decimal score would be rounded to an integer', async function () {
        const conn = { query: async () => [liveRow({ COLUMN_TYPE: 'decimal(8,4)', COLUMN_DEFAULT: '0.0000' })] };
        await assert.rejects(assertNoLiveColumnLoss(conn, 'f.sql',
            statementsOf('ALTER TABLE attest_validator_stats MODIFY quality_score INT DEFAULT 0;')),
            /narrows the type \(decimal\(8,4\) -> int\)/);
    });

    it('passes the timestamp to datetime move the committed auto migrations make', function () {
        assert.strictEqual(lossOf({ COLUMN_TYPE: 'timestamp', COLUMN_DEFAULT: 'current_timestamp()' },
            'DATETIME DEFAULT CURRENT_TIMESTAMP'), '');
    });
});

describe('migration live-schema MODIFY guard: omitted charset and collation @regression @tier1', function () {
    it('refuses a charset-less text MODIFY that falls back to a different table charset', function () {
        for (const table of ['utf8mb3_general_ci', 'utf8_general_ci']) {
            assert.match(lossOf(text('varchar(250)', 'utf8mb4', 'utf8mb4_general_ci', table), 'VARCHAR(500)'),
                /omits CHARACTER SET \(utf8mb4_general_ci -> table default utf8mb3_general_ci\)/, table);
        }
    });

    it('refuses a charset-less text MODIFY that drops a column collation', function () {
        assert.match(lossOf(text('varchar(100)', 'utf8mb3', 'utf8mb3_bin', 'utf8mb3_general_ci'), 'VARCHAR(200)'),
            /omits COLLATE \(utf8mb3_bin -> table default utf8mb3_general_ci\)/);
    });

    it('passes when the column already carries the table default or the MODIFY names its charset', function () {
        assert.strictEqual(lossOf(text("enum('a')", 'utf8mb3', 'utf8mb3_general_ci', 'utf8_general_ci'), "ENUM('a','b')"), '');
        assert.strictEqual(lossOf(text('varchar(250)', 'utf8mb4', 'utf8mb4_general_ci', 'utf8mb4_general_ci'), 'VARCHAR(500)'), '');
        assert.strictEqual(lossOf(text('varchar(250)', 'utf8mb4', 'utf8mb4_general_ci', 'utf8mb3_general_ci'),
            'VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci'), '');
    });
});

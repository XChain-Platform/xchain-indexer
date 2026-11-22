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
 * Live-schema guard safety for generated columns, qualified targets and
 * ordered statements in one migration file.
 ********************************************************************/

const fs = require('fs');
const path = require('path');
const { assert, destructiveOf, statementsOf } = require('../helpers/migration_fixtures.js');
const { assertNoLiveColumnLoss, alterSpecs } = require('../../../../../src/db/database/migration_live_schema_guard.js');

const liveRow = (over) => Object.assign({
    COLUMN_TYPE: 'int(11)', COLUMN_DEFAULT: null, EXTRA: '', COLUMN_COMMENT: '',
    GENERATION_EXPRESSION: '', IS_NULLABLE: 'NO', CHARACTER_SET_NAME: null,
    COLLATION_NAME: null, TABLE_COLLATION: null, ROW_FORMAT: 'Dynamic',
}, over);

async function verdict(live, sql, seen){
    const conn = { query: async (text) => { if(seen) seen.push(text); return live ? [live] : []; } };
    try { await assertNoLiveColumnLoss(conn, 'f.sql', statementsOf(sql)); return null; }
    catch (error) { return error.message; }
}

describe('migration live-schema guard generated-column safety @regression @tier1', function () {
    const virtual = liveRow({ EXTRA: 'VIRTUAL GENERATED', GENERATION_EXPRESSION: '`state_key`' });

    it('refuses expression rewrites, kind changes, conversions and unreadable clauses', async function () {
        assert.match(await verdict(virtual, "ALTER TABLE t MODIFY g INT AS ('') VIRTUAL;"), /changes the generation expression/);
        assert.match(await verdict(virtual, 'ALTER TABLE t MODIFY g INT AS (state_key) STORED;'), /changes the generation kind/);
        assert.match(await verdict(liveRow(), 'ALTER TABLE t MODIFY g INT AS (state_key) VIRTUAL;'), /stored column into a generated one/);
        assert.match(await verdict(virtual, 'ALTER TABLE t MODIFY g INT AS ((state_key) VIRTUAL;'), /cannot read/);
        assert.match(await verdict(liveRow({ EXTRA: 'VIRTUAL GENERATED', GENERATION_EXPRESSION: '`aorb`' }),
            'ALTER TABLE t MODIFY g INT AS (a or b) VIRTUAL;'), /changes the generation expression/);
    });

    it('allows cosmetic expression differences and equivalent generation kinds', async function () {
        for(const expression of ['state_key', '`state_key`', 'STATE_KEY', ' (state_key) '])
            assert.strictEqual(await verdict(virtual, 'ALTER TABLE t MODIFY g INT AS (' + expression + ');'), null, expression);
        const stored = liveRow({ EXTRA: 'STORED GENERATED', GENERATION_EXPRESSION: '`state_key`' });
        assert.strictEqual(await verdict(stored, 'ALTER TABLE t MODIFY g INT AS (state_key) PERSISTENT;'), null);
    });

    it('keeps charset introducers significant in a generation expression', async function () {
        const live = liveRow({ COLUMN_TYPE: 'varchar(10)', EXTRA: 'VIRTUAL GENERATED', GENERATION_EXPRESSION: "charset(_utf8mb4'x')" });
        assert.match(await verdict(live, "ALTER TABLE t MODIFY g VARCHAR(10) AS (CHARSET(_latin1'x')) VIRTUAL;"), /changes the generation expression/);
        assert.match(await verdict(live, "ALTER TABLE t MODIFY g VARCHAR(10) AS (CHARSET('x')) VIRTUAL;"), /changes the generation expression/);
        assert.strictEqual(await verdict(live, "ALTER TABLE t MODIFY g VARCHAR(10) AS (CHARSET(_utf8mb4'x')) VIRTUAL;"), null);
    });

    it('treats a backticked reserved-word column as different from the bare keyword', async function () {
        const live = liveRow({ EXTRA: 'VIRTUAL GENERATED', GENERATION_EXPRESSION: '`null`' });
        assert.match(await verdict(live, 'ALTER TABLE t MODIFY g INT AS (NULL) VIRTUAL;'), /changes the generation expression/);
        assert.strictEqual(await verdict(live, 'ALTER TABLE t MODIFY g INT AS (`null`) VIRTUAL;'), null);
    });

    it('treats bare NOT, BINARY and other reserved words as different from backticked columns', async function () {
        for(const [live, bare] of [['`not` + 1', 'NOT + 1'], ['`binary` + 1', 'BINARY + 1'],
            ['`interval` + 1', 'INTERVAL + 1'], ['`case`', 'CASE'], ['`user`()', 'USER()']]){
            const row = liveRow({ EXTRA: 'VIRTUAL GENERATED', GENERATION_EXPRESSION: live });
            assert.match(await verdict(row, 'ALTER TABLE t MODIFY g INT AS (' + bare + ') VIRTUAL;'),
                /changes the generation expression/, bare);
            assert.strictEqual(await verdict(row, 'ALTER TABLE t MODIFY g INT AS (' + live + ') VIRTUAL;'), null, live);
        }
    });

    it('still allows a restated expression whose keywords and functions match the stored form', async function () {
        for(const [live, written] of [['`a` is not null', 'a IS NOT NULL'], ["concat(`a`,'x')", "CONCAT(a, 'x')"],
            ['`a` div 2', 'a DIV 2']]){
            const row = liveRow({ EXTRA: 'VIRTUAL GENERATED', GENERATION_EXPRESSION: live });
            assert.strictEqual(await verdict(row, 'ALTER TABLE t MODIFY g INT AS (' + written + ') VIRTUAL;'), null, written);
        }
    });
});

describe('migration live-schema guard qualified write target safety @regression @tier1', function () {
    it('classifies every schema-qualified write target as non-auto-eligible', function () {
        for(const sql of [
            'ALTER ONLINE TABLE `other` . `events` WAIT 5 MODIFY data TEXT',
            'CREATE TEMPORARY TABLE IF NOT EXISTS other.events (id INT)',
            'CREATE UNIQUE INDEX IF NOT EXISTS ix ON other.events (id)',
            'DROP INDEX IF EXISTS ix ON other.events',
            'DROP TEMPORARY TABLE IF EXISTS local_tmp, other.remote_tmp',
            'INSERT HIGH_PRIORITY INTO other.events (id) VALUES (1)',
            'UPDATE other.events SET id = 1',
        ]) assert.strictEqual(destructiveOf([sql]), sql, sql);
    });

    it('classifies qualified index targets after an index type and in a temporary drop list', function () {
        for(const sql of [
            'CREATE INDEX ix USING BTREE ON other.events (id)',
            'CREATE UNIQUE INDEX IF NOT EXISTS ix USING HASH ON `other`.`events` (id)',
            'DROP TEMPORARY TABLE IF EXISTS local_tmp, other.remote_tmp WAIT 5',
        ]) assert.strictEqual(destructiveOf([sql]), sql, sql);
        for(const sql of ['CREATE INDEX ix USING BTREE ON events (id)', 'CREATE INDEX ix ON events (id) USING BTREE',
            'DROP TEMPORARY TABLE IF EXISTS local_tmp WAIT 0.5']) assert.strictEqual(destructiveOf([sql]), null, sql);
    });

    it('refuses a target it cannot prove bare, including non-ASCII schema names', function () {
        for(const sql of [
            'INSERT INTO ötherdb.events (id) VALUES (1)',
            'CREATE INDEX ix ON ötherdb.events (id)',
            'ALTER TABLE ötherdb.events ADD COLUMN x INT',
            'INSERT INTO /*!50000 other. */ events (id) VALUES (1)',
            'SET STATEMENT max_statement_time=0 FOR INSERT INTO other.events (id) VALUES (1)',
        ]) assert.strictEqual(destructiveOf([sql]), sql, sql);
        assert.strictEqual(destructiveOf(['INSERT INTO événements (id) VALUES (1)']), null);
    });

    it('does not mistake dotted source columns for a qualified write target', function () {
        const sql = 'INSERT INTO events (id) SELECT e.id FROM events e JOIN dup d ON e.id = d.id';
        assert.strictEqual(destructiveOf([sql]), null);
        assert.strictEqual(destructiveOf(['ALTER TABLE events ADD COLUMN data TEXT']), null);
        assert.strictEqual(destructiveOf(['ALTER TABLE `events.archive` ADD COLUMN data TEXT']), null);
    });

    it('refuses a schema-qualified MODIFY before reading information_schema', async function () {
        const seen = [];
        assert.deepStrictEqual(alterSpecs('ALTER TABLE `other` . `events` MODIFY data TEXT').schema, 'other');
        assert.strictEqual(alterSpecs('ALTER TABLE `events.archive` MODIFY data TEXT').schema, null);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'text' }),
            'ALTER TABLE other.events MODIFY data MEDIUMTEXT;', seen), /schema-qualified other\.events/);
        assert.deepStrictEqual(seen, []);
    });

});

describe('migration live-schema guard target and statement-order safety @regression @tier1', function () {
    it('refuses a MODIFY that depends on an earlier statement in the file', async function () {
        for(const sql of [
            'ALTER TABLE sends ADD COLUMN migration_cursor BIGINT AUTO_INCREMENT; ALTER TABLE sends MODIFY migration_cursor BIGINT NULL;',
            'ALTER TABLE t ADD COLUMN c INT, MODIFY c BIGINT;',
            'ALTER TABLE t MODIFY c INT; ALTER TABLE t MODIFY c BIGINT;',
            'CREATE TABLE t (c INT); ALTER TABLE t MODIFY c BIGINT;',
            'ALTER TABLE t ADD COLUMN (a INT, b INT); ALTER TABLE t MODIFY b BIGINT;',
            'ALTER TABLE t ADD COLUMN `Migration_Cursor` INT; ALTER TABLE T MODIFY migration_cursor BIGINT;',
        ]) assert.match(await verdict(null, sql), /depends on an earlier/);
    });

    it('refuses a MODIFY after an ALTER COLUMN or a table-wide change in the file', async function () {
        for(const sql of [
            'ALTER TABLE t ALTER COLUMN c SET DEFAULT 7; ALTER TABLE t MODIFY c INT;',
            'ALTER TABLE t ALTER c DROP DEFAULT; ALTER TABLE t MODIFY c INT DEFAULT 1;',
            'ALTER TABLE t ALTER COLUMN c SET DEFAULT 7, MODIFY c INT;',
            'ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4; ALTER TABLE t MODIFY c VARCHAR(10);',
            'ALTER TABLE t ROW_FORMAT=COMPACT; ALTER TABLE t MODIFY c VARCHAR(10);',
            'ALTER TABLE a RENAME TO b; ALTER TABLE b MODIFY c INT;',
        ]) assert.match(await verdict(null, sql), /depends on an earlier/, sql);
        assert.strictEqual(await verdict(null, 'ALTER TABLE t ALTER COLUMN d SET DEFAULT 7; ALTER TABLE t MODIFY c INT;'), null);
        assert.strictEqual(await verdict(null, 'ALTER TABLE t ADD INDEX ix (c), ALGORITHM=INPLACE, LOCK=NONE; ALTER TABLE t MODIFY c INT;'), null);
    });

    it('refuses a MODIFY after a CREATE TABLE or ADD written without a space before the paren', async function () {
        for(const sql of [
            'CREATE TABLE t(c INT); ALTER TABLE t MODIFY c BIGINT;',
            'ALTER TABLE t ADD(c INT AUTO_INCREMENT UNIQUE); ALTER TABLE t MODIFY c INT;',
        ]) assert.match(await verdict(null, sql), /depends on an earlier/, sql);
    });

    it('allows unrelated earlier clauses and a later ADD', async function () {
        assert.strictEqual(await verdict(null, 'ALTER TABLE t MODIFY x BIGINT; ALTER TABLE t ADD COLUMN y INT;'), null);
        assert.strictEqual(await verdict(null, 'ALTER TABLE t ADD INDEX ix (x); ALTER TABLE t MODIFY x BIGINT;'), null);
    });

    it('accepts every committed auto migration under the ordered-statement rule', async function () {
        const dir = path.join(__dirname, '../../../../../src/sql/migrations');
        for(const name of fs.readdirSync(dir).filter(name => name.endsWith('.sql'))){
            const sql = fs.readFileSync(path.join(dir, name), 'utf8');
            if(!/^\s*--\s*xchain:migration\s+mode=auto\b/im.test(sql)) continue;
            assert.strictEqual(await verdict(null, sql), null, name);
        }
    });

    it('leaves every committed auto migration auto-eligible under the qualified-target rule', function () {
        const dir = path.join(__dirname, '../../../../../src/sql/migrations');
        let checked = 0;
        for(const name of fs.readdirSync(dir).filter(name => name.endsWith('.sql'))){
            const sql = fs.readFileSync(path.join(dir, name), 'utf8');
            if(!/^\s*--\s*xchain:migration\s+mode=auto\b/im.test(sql)) continue;
            checked++;
            assert.strictEqual(destructiveOf(statementsOf(sql)), null, name);
        }
        assert.ok(checked > 0, 'no committed auto migration was read');
    });
});

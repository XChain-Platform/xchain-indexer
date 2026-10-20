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
 * Schema migration runner: the closing statement-form allow-list of the auto-apply scan.
 *
 * A mode=auto statement must open with ALTER [ONLINE] TABLE, CREATE [TEMPORARY] TABLE,
 * CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX, DROP INDEX, DROP TEMPORARY TABLE, INSERT, UPDATE
 * or SET. Any other form can make the server do something a prefix classifier cannot see.
 *
 ********************************************************************/

const { assert, destructiveOf } = require('./helpers/migration_fixtures.js');

describe('Database._destructiveAutoStatement() statement-form allow-list @regression @tier1', function () {
    it('flags every statement form outside the allow-list', function () {
        for (const stmt of [
            "BINLOG 'AAAA'",
            'DO purge_stale_rows()',
            'SELECT purge_stale_rows()',
            'WITH x AS (SELECT 1) SELECT * FROM x',
            '(SELECT 1)',
            'PURGE BINARY LOGS BEFORE NOW()',
            'RESET MASTER',
            "INSTALL SONAME 'ha_example'",
            'UNINSTALL PLUGIN example',
            'FLUSH TABLES',
            'KILL 1',
            "GRANT ALL ON *.* TO 'u'@'%'",
            "REVOKE ALL ON *.* FROM 'u'@'%'",
            'HANDLER balances OPEN',
            'LOCK TABLES balances WRITE',
            'ANALYZE TABLE balances',
            'OPTIMIZE TABLE balances',
            'BEGIN NOT ATOMIC DELETE FROM balances; END',
            'XA START 1',
        ]) {
            assert.strictEqual(destructiveOf([stmt]), stmt, stmt + ' must not be auto-eligible');
        }
    });

    it('keeps every allowed form auto-eligible', function () {
        for (const stmt of [
            'ALTER TABLE balances ADD COLUMN note TEXT NULL',
            'ALTER ONLINE TABLE balances ADD INDEX note_idx (note)',
            'CREATE TABLE IF NOT EXISTS notes (id INT)',
            'CREATE TEMPORARY TABLE scratch (id INT)',
            'CREATE INDEX note_idx ON notes (id)',
            'CREATE UNIQUE INDEX note_uq ON notes (id)',
            'DROP INDEX IF EXISTS note_idx ON notes',
            'DROP TEMPORARY TABLE scratch',
            "INSERT INTO notes (body) VALUES ('a')",
            'UPDATE notes SET id = (SELECT MAX(id) + 1 FROM notes) WHERE id = 0',
            "SET time_zone = '+00:00'",
        ]) {
            assert.strictEqual(destructiveOf([stmt]), null, stmt + ' must stay auto-eligible');
        }
    });

    it('flags an unlisted form that follows an allowed one in the same file', function () {
        assert.strictEqual(destructiveOf(['ALTER TABLE notes ADD COLUMN x INT NULL', 'DO purge_stale_rows()']),
            'DO purge_stale_rows()');
    });
});

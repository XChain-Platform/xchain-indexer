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
 * Schema migration runner: DROP target rule of the auto-apply scan.
 *
 * Only a bare, unquoted metadata keyword may follow DROP in an auto ALTER. A quoted
 * name is always a column, and a token the scan cannot read is not provably safe.
 *
 ********************************************************************/

const { assert, destructiveOf } = require('./helpers/migration_fixtures.js');

const KEYWORDS = ['index', 'key', 'foreign', 'constraint', 'check', 'default', 'primary'];

describe('Database._destructiveAutoStatement() DROP target @regression @tier1', function () {
    it('flags a DROP of a backtick-quoted column named like a metadata keyword', function () {
        for (const kw of KEYWORDS) {
            for (const name of [kw, kw.toUpperCase()]) {
                const stmt = 'ALTER TABLE t DROP `' + name + '`';
                assert.strictEqual(destructiveOf([stmt]), stmt, stmt + ' must not be auto-eligible');
            }
        }
    });

    it('flags a DROP whose target only starts with a keyword or cannot be read', function () {
        for (const stmt of [
            'ALTER TABLE t DROP key1',
            'ALTER TABLE t DROP default2',
            'ALTER TABLE t DROP 1col',
            'ALTER TABLE t DROP "key"',
            'ALTER TABLE t DROP`key`',
            'ALTER TABLE t ADD COLUMN y INT NULL, DROP `primary`',
        ]) {
            assert.strictEqual(destructiveOf([stmt]), stmt, stmt + ' must not be auto-eligible');
        }
    });

    it('keeps bare metadata-only DROP forms auto-eligible', function () {
        for (const stmt of [
            'ALTER TABLE t DROP INDEX IF EXISTS idx',
            'alter table t drop key k',
            'ALTER TABLE t DROP INDEX `idx_name`',
            'ALTER TABLE t DROP INDEX`idx_name`',
            'ALTER TABLE t DROP FOREIGN KEY `fk_b`',
            'ALTER TABLE t DROP CONSTRAINT chk',
            'ALTER TABLE t DROP CHECK chk',
            'ALTER TABLE t DROP PRIMARY KEY, ADD PRIMARY KEY (id, seq)',
            'ALTER TABLE t ALTER COLUMN x DROP DEFAULT',
            'ALTER TABLE t ALTER COLUMN `key` DROP DEFAULT',
            'ALTER TABLE t ALTER COLUMN x DROP DEFAULT, ADD COLUMN y INT NULL',
        ]) {
            assert.strictEqual(destructiveOf([stmt]), null, stmt + ' must stay auto-eligible');
        }
    });
});

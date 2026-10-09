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
 * Schema migration runner: storage-engine rule of the auto-apply scan.
 *
 * MEMORY loses every row on restart and MyISAM/Aria sit outside the transaction a
 * reorg rollback undoes, so only InnoDB tables may be created or kept by an auto file.
 *
 ********************************************************************/

const { assert, destructiveOf } = require('./helpers/migration_fixtures.js');

describe('Database._destructiveAutoStatement() storage engine @regression @tier1', function () {
    it('flags every ALTER TABLE that names an ENGINE, InnoDB included', function () {
        for (const stmt of [
            'ALTER TABLE balances ENGINE=Aria',
            'ALTER TABLE balances ENGINE=MyISAM',
            'ALTER TABLE balances ENGINE = MEMORY',
            'ALTER TABLE balances ENGINE=InnoDB',
            'alter table t engine myisam',
            'ALTER ONLINE TABLE t ENGINE=InnoDB',
            'ALTER TABLE t ADD COLUMN c INT NULL, ENGINE=Aria',
        ]) {
            assert.strictEqual(destructiveOf([stmt]), stmt, stmt + ' must not be auto-eligible');
        }
    });

    it('flags a CREATE TABLE that names any engine other than InnoDB', function () {
        for (const stmt of [
            'CREATE TABLE t (id BIGINT) ENGINE=MEMORY',
            'CREATE TEMPORARY TABLE t (id BIGINT) ENGINE=MyISAM',
            "CREATE TABLE t (id BIGINT) ENGINE='Aria'",
            'CREATE TABLE IF NOT EXISTS t (id BIGINT) engine = `MyISAM`',
            'CREATE TABLE t (id BIGINT) ENGINE Aria',
        ]) {
            assert.strictEqual(destructiveOf([stmt]), stmt, stmt + ' must not be auto-eligible');
        }
    });

    it('keeps InnoDB and engine-less CREATE TABLE and unrelated ALTERs auto-eligible', function () {
        for (const stmt of [
            'CREATE TABLE t (id BIGINT) ENGINE=InnoDB',
            'CREATE TABLE IF NOT EXISTS t (id BIGINT) engine = innodb',
            "CREATE TABLE t (id BIGINT) ENGINE='InnoDB' DEFAULT CHARSET=utf8mb4",
            'CREATE TEMPORARY TABLE t (id BIGINT) ENGINE=InnoDB',
            'CREATE TABLE t (id BIGINT)',
            'ALTER TABLE t ADD COLUMN c INT NULL',
            'ALTER TABLE t ADD COLUMN engine_kind INT NULL',
        ]) {
            assert.strictEqual(destructiveOf([stmt]), null, stmt + ' must stay auto-eligible');
        }
    });
});

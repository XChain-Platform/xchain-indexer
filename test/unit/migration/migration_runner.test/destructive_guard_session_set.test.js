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
 * Schema migration runner: the session-SET allow-list of the auto-apply scan.
 *
 * Only SET NAMES and a single UTC time_zone may ride in a mode=auto file. A relaxed
 * sql_mode (or foreign_key_checks, unique_checks, ...) switches off the strict-mode
 * backstop, so a narrowing MODIFY later in the same file truncates instead of
 * failing; SET STATEMENT ... FOR hides a whole statement behind the SET keyword.
 *
 ********************************************************************/

const { assert, modeOf, destructiveOf, statementsOf } = require('./helpers/migration_fixtures.js');

describe('Database._destructiveAutoStatement() session SETs @regression @tier1', function () {
    it('keeps the allow-listed spellings auto-eligible', function () {
        for (const stmt of [
            'SET NAMES utf8mb4',
            'SET NAMES utf8mb4 COLLATE utf8mb4_general_ci',
            "SET time_zone = '+00:00'",
            "SET SESSION time_zone='+00:00'",
            "SET @@session.time_zone = '+00:00'",
        ]) {
            assert.strictEqual(destructiveOf([stmt]), null, stmt + ' must stay auto-eligible');
        }
    });

    it('flags every other SET: sql_mode, check flags, GLOBAL, multi-assignment, other zones, SET STATEMENT', function () {
        for (const stmt of [
            'SET sql_mode = "STRICT_ALL_TABLES"',
            "SET sql_mode='NO_ENGINE_SUBSTITUTION'",
            "SET SESSION sql_mode=''",
            'SET @@session.foreign_key_checks = 0',
            'SET @@local.unique_checks=0',
            'SET foreign_key_checks = 0',
            "SET GLOBAL sql_mode=''",
            "SET @@global.time_zone = '+00:00'",
            "SET time_zone='+00:00', sql_mode=''",
            "SET time_zone='+05:00'",
            'SET STATEMENT max_statement_time=0 FOR DROP TABLE balances',
            'SET CHARACTER SET utf8mb4',
        ]) {
            assert.strictEqual(destructiveOf([stmt]), stmt, stmt + ' must not be auto-eligible');
        }
    });

    it('flags the relax-then-narrow file end to end, and keeps a UTC zone before an additive ALTER auto', function () {
        const raw = '-- xchain:migration mode=auto\n' +
            "SET sql_mode = 'NO_ENGINE_SUBSTITUTION';\n" +
            'ALTER TABLE sends MODIFY amount VARCHAR(30);\n';
        assert.strictEqual(modeOf(raw), 'auto');
        assert.match(String(destructiveOf(statementsOf(raw))), /^SET sql_mode/);
        assert.strictEqual(destructiveOf(["SET time_zone = '+00:00'", 'ALTER TABLE t ADD INDEX IF NOT EXISTS k (c)']), null);
    });
});

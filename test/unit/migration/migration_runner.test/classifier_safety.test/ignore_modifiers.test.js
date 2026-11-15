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
 ********************************************************************/

'use strict';

const assert = require('assert');
const Database = require('../../../../../src/db');
const scan = Database.prototype.destructiveAutoStatement.bind(Database.prototype);

describe('auto migration IGNORE and REPLACE SELECT guard @regression', function () {
    it('refuses statement-local strict-mode bypasses', function () {
        for(const sql of [
            'INSERT IGNORE INTO t (a) VALUES (1)',
            'INSERT LOW_PRIORITY IGNORE INTO t SELECT a FROM s',
            'INSERT HIGH_PRIORITY IGNORE INTO t SET a = 1',
            'CREATE TABLE t2 IGNORE SELECT a FROM s',
            'CREATE TABLE IF NOT EXISTS t2 (a INT) IGNORE AS SELECT a FROM s',
            'CREATE TEMPORARY TABLE t2 REPLACE SELECT a FROM s',
        ]) assert.strictEqual(scan([sql]), sql, sql);
    });

    it('keeps literals, identifiers, functions and plain inserts eligible', function () {
        for(const sql of [
            "INSERT INTO notes (body) VALUES ('IGNORE')",
            'CREATE TABLE t2 AS SELECT a FROM s',
            "CREATE TABLE t (a VARCHAR(20) DEFAULT 'ignore select')",
            'CREATE TABLE t (`ignore` INT)',
            "CREATE TABLE t (a VARCHAR(10), b VARCHAR(10) AS (REPLACE(a, 'x', 'y')) VIRTUAL)",
        ]) assert.strictEqual(scan([sql]), null, sql);
    });
});

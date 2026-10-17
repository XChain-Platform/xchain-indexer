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
 * Schema migration runner: the WAIT n / NOWAIT lock-wait option and unplaced MODIFYs.
 *
 * MariaDB allows `ALTER TABLE t [WAIT n | NOWAIT] MODIFY ...`. Both the auto-apply scan and
 * the live-schema guard must read the MODIFY behind that option, and a MODIFY keyword neither
 * can place must refuse the file rather than slip past both checks.
 *
 ********************************************************************/

const { assert, destructiveOf, statementsOf } = require('./helpers/migration_fixtures.js');
const { assertNoLiveColumnLoss, modifyClauses } = require('../../../../src/db/database/migration_live_schema_guard.js');

// The guard's verdict on one statement against one live column row (null when it passes).
async function guardVerdict(live, sql) {
    const conn = { query: async () => (live ? [live] : []) };
    try { await assertNoLiveColumnLoss(conn, 'f.sql', statementsOf(sql)); return null; }
    catch (e) { return e.message; }
}

describe('Database._destructiveAutoStatement() lock-wait head and unplaced MODIFY @regression @tier1', function () {
    it('flags a MODIFY of id that drops AUTO_INCREMENT behind WAIT n, NOWAIT or IF EXISTS', function () {
        for (const stmt of [
            'ALTER TABLE t NOWAIT MODIFY id BIGINT UNSIGNED',
            'ALTER TABLE t WAIT 10 MODIFY id BIGINT',
            'ALTER TABLE t WAIT 2.5 MODIFY COLUMN id BIGINT',
            'ALTER TABLE IF EXISTS t MODIFY id BIGINT',
            'ALTER ONLINE TABLE `t` NOWAIT ADD COLUMN c INT, MODIFY id BIGINT',
        ]) {
            assert.strictEqual(destructiveOf([stmt]), stmt, stmt + ' must not be auto-eligible');
        }
    });

    it('flags a MODIFY keyword that does not open its alter_spec', function () {
        for (const stmt of [
            'ALTER TABLE t FROBNICATE MODIFY id BIGINT NOT NULL AUTO_INCREMENT',
            'ALTER TABLE `db`.`t` WAIT x MODIFY n INT',
            'ALTER TABLE t ADD COLUMN c INT, ALGORITHM=INPLACE MODIFY n INT',
        ]) {
            assert.strictEqual(destructiveOf([stmt]), stmt, stmt + ' must not be auto-eligible');
        }
    });

    it('keeps lock-wait ALTERs that restate AUTO_INCREMENT or only add auto-eligible', function () {
        for (const stmt of [
            'ALTER TABLE t WAIT 10 MODIFY id BIGINT NOT NULL AUTO_INCREMENT',
            'ALTER TABLE t NOWAIT ADD COLUMN c INT',
            'ALTER TABLE IF EXISTS t NOWAIT MODIFY memo MEDIUMTEXT NULL',
            "ALTER TABLE t ADD COLUMN c INT COMMENT 'NOWAIT MODIFY later'",
        ]) {
            assert.strictEqual(destructiveOf([stmt]), null, stmt + ' must stay auto-eligible');
        }
    });
});

describe('migration live-schema MODIFY guard: lock-wait head and unplaced MODIFY @regression @tier1', function () {
    it('finds the MODIFY behind WAIT n and NOWAIT', function () {
        for (const sql of ['ALTER TABLE t NOWAIT MODIFY id BIGINT UNSIGNED;', 'ALTER TABLE t WAIT 30 MODIFY id BIGINT UNSIGNED;']) {
            assert.deepStrictEqual(modifyClauses(statementsOf(sql)).map(m => [m.table, m.column, m.definition]),
                [['t', 'id', 'BIGINT UNSIGNED']], sql);
        }
    });

    it('refuses a lock-wait MODIFY that strips AUTO_INCREMENT or a DEFAULT', async function () {
        assert.match(await guardVerdict({ COLUMN_TYPE: 'bigint(20) unsigned', EXTRA: 'auto_increment' },
            'ALTER TABLE price_snapshots NOWAIT MODIFY id BIGINT UNSIGNED;'), /strips AUTO_INCREMENT/);
        assert.match(await guardVerdict({ COLUMN_TYPE: 'tinyint(1)', COLUMN_DEFAULT: '0' },
            'ALTER TABLE tokens WAIT 10 MODIFY lock_bridge TINYINT(1);'), /strips DEFAULT 0/);
    });

    it('refuses a MODIFY it cannot place instead of skipping it', async function () {
        for (const sql of ['ALTER TABLE t FROBNICATE MODIFY n INT;', 'ALTER TABLE `db`.`t` WAIT x MODIFY n INT;']) {
            assert.match(await guardVerdict(null, sql), /carries a MODIFY this guard cannot read/, sql);
        }
    });

    it('does not count a MODIFY inside a quoted literal', async function () {
        assert.strictEqual(await guardVerdict(null, "ALTER TABLE t NOWAIT ADD COLUMN c INT COMMENT 'modify later';"), null);
        assert.deepStrictEqual(modifyClauses(statementsOf("ALTER TABLE t ADD COLUMN c INT COMMENT 'x, MODIFY y';")), []);
    });
});

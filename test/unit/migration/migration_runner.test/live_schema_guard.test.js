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
 * Live-schema MODIFY guard: an auto migration whose MODIFY would strip or narrow a live
 * column is refused before it runs.
 *
 ********************************************************************/

const { assert, statementsOf } = require('./helpers/migration_fixtures.js');
const { assertNoLiveColumnLoss, modifyClauses } = require('../../../../src/db/database/migration_live_schema_guard.js');

const liveRow = (over) => Object.assign({
    COLUMN_TYPE: 'bigint(20) unsigned', COLUMN_DEFAULT: null, EXTRA: '', COLUMN_COMMENT: '',
    GENERATION_EXPRESSION: '', CHARACTER_SET_NAME: null,
}, over);

async function verdict(live, sql) {
    const conn = { query: async () => (live ? [live] : []) };
    try { await assertNoLiveColumnLoss(conn, 'f.sql', statementsOf(sql)); return null; }
    catch (e) { return e.message; }
}

describe('migration live-schema MODIFY guard @regression @tier1', function () {
    it('finds each MODIFY clause, ignoring FIRST/AFTER and other clauses', function () {
        const got = modifyClauses(statementsOf(
            'ALTER TABLE `t` MODIFY COLUMN a INT NOT NULL AFTER b, ADD COLUMN c INT, MODIFY d VARCHAR(10) DEFAULT \'x,y\';'));
        assert.deepStrictEqual(got.map(g => [g.table, g.column]), [['t', 'a'], ['t', 'd']]);
        assert.strictEqual(got[0].definition, 'INT NOT NULL');
    });

    it('refuses a MODIFY that strips AUTO_INCREMENT', async function () {
        const m = await verdict(liveRow({ EXTRA: 'auto_increment' }), 'ALTER TABLE t MODIFY id BIGINT UNSIGNED NOT NULL;');
        assert.match(m, /strips AUTO_INCREMENT/);
    });

    it('refuses a MODIFY that strips a DEFAULT', async function () {
        const m = await verdict(liveRow({ COLUMN_TYPE: 'int(11)', COLUMN_DEFAULT: '0' }), 'ALTER TABLE t MODIFY n INT NOT NULL;');
        assert.match(m, /strips DEFAULT 0/);
    });

    it('refuses a MODIFY that strips ON UPDATE, COMMENT or a generation expression', async function () {
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'timestamp', EXTRA: 'on update current_timestamp()' }),
            'ALTER TABLE t MODIFY u TIMESTAMP;'), /strips ON UPDATE/);
        assert.match(await verdict(liveRow({ COLUMN_COMMENT: 'why' }), 'ALTER TABLE t MODIFY n BIGINT UNSIGNED;'), /strips COMMENT/);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'int(11)', EXTRA: 'VIRTUAL GENERATED', GENERATION_EXPRESSION: '`a` + 1' }),
            'ALTER TABLE t MODIFY g INT;'), /generation expression/);
    });

    it('refuses narrowing of type, length and charset', async function () {
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'bigint(20)' }), 'ALTER TABLE t MODIFY n INT;'), /narrows the type/);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'bigint(20)' }), 'ALTER TABLE t MODIFY n BIGINT UNSIGNED;'), /narrows the type/);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'varchar(250)', CHARACTER_SET_NAME: 'utf8mb4' }),
            'ALTER TABLE t MODIFY s VARCHAR(100) CHARACTER SET utf8mb4;'), /varchar\(250\) -> varchar\(100\)/);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: 'varchar(250)', CHARACTER_SET_NAME: 'utf8mb4' }),
            'ALTER TABLE t MODIFY s VARCHAR(250) CHARACTER SET utf8;'), /charset/);
        assert.match(await verdict(liveRow({ COLUMN_TYPE: "enum('a','b')" }), "ALTER TABLE t MODIFY e ENUM('a');"), /drops b/);
    });

    it('passes a MODIFY that restates every attribute or only widens', async function () {
        assert.strictEqual(await verdict(liveRow({ EXTRA: 'auto_increment' }),
            'ALTER TABLE t MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;'), null);
        assert.strictEqual(await verdict(liveRow({ COLUMN_TYPE: 'int(11)', COLUMN_DEFAULT: '0', COLUMN_COMMENT: 'c' }),
            "ALTER TABLE t MODIFY n INT NOT NULL DEFAULT 0 COMMENT 'c';"), null);
        assert.strictEqual(await verdict(liveRow({ COLUMN_TYPE: 'varchar(130)', CHARACTER_SET_NAME: 'utf8mb4' }),
            'ALTER TABLE t MODIFY s VARCHAR(250) CHARACTER SET utf8mb4;'), null);
        assert.strictEqual(await verdict(liveRow({ COLUMN_TYPE: "enum('a')" }), "ALTER TABLE t MODIFY e ENUM('a','b');"), null);
    });

    it('does not read a keyword inside a string literal as an attribute', async function () {
        const m = await verdict(liveRow({ COLUMN_TYPE: 'varchar(10)', COLUMN_DEFAULT: "'x'" }),
            "ALTER TABLE t MODIFY s VARCHAR(10) COMMENT 'DEFAULT here';");
        assert.match(m, /strips DEFAULT/);
    });

    it('passes when the live column is absent or the probe answers without a column row', async function () {
        assert.strictEqual(await verdict(null, 'ALTER TABLE t MODIFY n INT;'), null);
        assert.strictEqual(await verdict({ len: 130 }, 'ALTER TABLE t MODIFY n INT;'), null);
    });
});

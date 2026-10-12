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
 * Column parity, literal-case half: a pre-ledger column keeps the exact case of
 * its DEFAULT, ENUM and COMMENT literals unless a dated migration MODIFYs it.
 * MariaDB stores literal case in COLUMN_DEFAULT and COLUMN_TYPE and boot never
 * retypes an existing column, so a definition-only recase splits fresh and aged
 * installs. Part of the column parity suite; see ../sql_schema_column_parity.test.js.
 ********************************************************************/

const assert = require('assert');
const path   = require('path');

const { loadPinnedOriginFixture } = require('../../../helpers/pinnedOriginFixture');
const {
    collectDefinitionColumns, collectMigrationModifies, stripInlineKeys,
    sqlLiterals, upperOutsideLiterals,
} = require('./helpers/column_ledger.js');

const FIXTURES               = path.join(__dirname, '..', '..', '..', 'fixtures');
const ORIGIN_BASELINE        = path.join(FIXTURES, 'schema-baseline-origin.json');
const ORIGIN_BASELINE_SHA256 = 'b9f13cbbf4d6c8c746a1ba15fb56eb20934b46d269d3194370c3852839515c45';
// The literal anchor and its pin: moving either is a deliberate, reviewed edit.
const LITERAL_ORIGIN         = path.join(FIXTURES, 'schema-literal-origin.json');
const LITERAL_ORIGIN_SHA256  = '6bb7b0fe7c6b32ab7ca17fab32cfe6d88b402e683d3d6da8638f82830795b936';
const CONSUMER               = 'test/unit/migration/sql_schema_column_parity.test/literal_case.test.js';

describe('SQL schema column parity (literal case) @regression', function () {
    it('the literal helpers keep literal case and honour quote escapes', function () {
        assert.deepStrictEqual(sqlLiterals("ENUM('a','B') DEFAULT 'a'"), ["'a'", "'B'", "'a'"]);
        assert.deepStrictEqual(sqlLiterals("DEFAULT 'it''s' COMMENT 'x\\'y'"), ["'it''s'", "'x\\'y'"]);
        assert.strictEqual(upperOutsideLiterals("enum('pending','Ok') not null default 'pending'"),
            "ENUM('pending','Ok') NOT NULL DEFAULT 'pending'");
    });

    it('the literal anchor covers every literal-bearing origin column, in order @regression', function () {
        const origin   = loadPinnedOriginFixture(ORIGIN_BASELINE, ORIGIN_BASELINE_SHA256, CONSUMER);
        const literals = loadPinnedOriginFixture(LITERAL_ORIGIN, LITERAL_ORIGIN_SHA256, CONSUMER).literals;

        const want = {};
        for (const [table, cols] of Object.entries(origin.baseline || {}))
            for (const c of cols) {
                const found = sqlLiterals(c.spec);
                if (found.length) want[table + '.' + c.name] = found;
            }
        const got = Object.fromEntries(Object.entries(literals).map(([k, v]) => [k, v.map(l => l.toUpperCase())]));

        assert.ok(Object.keys(want).length > 0, 'the origin anchor carries no literal, so this guard checks nothing');
        assert.deepStrictEqual(got, want,
            'test/fixtures/schema-literal-origin.json no longer lists exactly the quoted literals of the ' +
            'literal-bearing columns in test/fixtures/schema-baseline-origin.json (compared case-folded, in ' +
            'order). Seed any missing entry from the definition at the origin commit, never from today\'s tree.');
    });

    it('a pre-ledger column keeps its literal case unless a dated migration MODIFYs it @regression', function () {
        const literals = loadPinnedOriginFixture(LITERAL_ORIGIN, LITERAL_ORIGIN_SHA256, CONSUMER).literals;
        const defs     = collectDefinitionColumns();
        const last     = new Map();
        for (const m of collectMigrationModifies()) last.set(m.table + '.' + m.name.toLowerCase(), m);

        const recased = [];
        let checked   = 0;
        for (const [key, frozen] of Object.entries(literals)) {
            const [table, name] = key.split('.');
            const d = (defs[table] || []).find(c => c.name.toLowerCase() === name.toLowerCase());
            if (!d) continue;                      // retired: the retirement cases own it
            checked++;
            const now = sqlLiterals(d.spec);
            if (JSON.stringify(now) === JSON.stringify(frozen)) continue;
            const m = last.get(table + '.' + name.toLowerCase());
            if (m && stripInlineKeys(m.spec) === stripInlineKeys(d.spec)) continue;
            recased.push(`  ${key}\n    origin:     ${frozen.join(',')}\n    definition: ${now.join(',')}`);
        }

        assert.ok(checked > 0, 'no literal-bearing origin column is still declared, so this guard checks nothing');
        assert.deepStrictEqual(recased, [],
            'These pre-ledger columns changed the text of a quoted literal (a DEFAULT, ENUM member or COMMENT) ' +
            'in src/sql/<table>.sql with no dated migration behind it. A fresh install takes the new text while ' +
            'every aged DB keeps the old one, because boot never retypes an existing column. Ship a dated ' +
            'ALTER TABLE ... MODIFY carrying the new literal, spec identical to the definition. Editing ' +
            'test/fixtures/schema-literal-origin.json or its sha256 pin is not a fix:\n' + recased.join('\n'));
    });
});

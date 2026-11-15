/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Column parity, table-tail half: the ENGINE / CHARSET / COLLATE / ROW_FORMAT tail of a
 * pre-ledger table is pinned in test/fixtures/schema-tail-origin.json. A definition whose
 * tail has moved off that anchor must be matched by a dated ALTER TABLE migration naming
 * the new value, because createTable only runs for an absent table and no reconciler
 * retypes an existing one, so an unmigrated tail edit splits fresh and aged installs.
 * The convergence suite in test/integration builds its aged side from the same anchor.
 * Part of the column parity suite; see ../sql_schema_column_parity.test.js.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { loadPinnedOriginFixture } = require('../../../helpers/pinnedOriginFixture');

const FIXTURES               = path.join(__dirname, '..', '..', '..', 'fixtures');
const SQL_DIR                = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');
const MIGRATIONS_DIR         = path.join(SQL_DIR, 'migrations');
const ORIGIN_BASELINE        = path.join(FIXTURES, 'schema-baseline-origin.json');
const ORIGIN_BASELINE_SHA256 = 'b9f13cbbf4d6c8c746a1ba15fb56eb20934b46d269d3194370c3852839515c45';
const TAIL_ORIGIN            = path.join(FIXTURES, 'schema-tail-origin.json');
const ORIGIN_TAIL_SHA256     = '5354be568bc659aeb40615f37a9fa3db4a32e0977e91d18be5fc86dad5c42032';
const CONSUMER               = 'test/unit/migration/sql_schema_column_parity.test/table_tail_origin.test.js';

// The tail text of a CREATE TABLE definition, from the closing paren to the semicolon.
function definitionTail(sql) {
    const match = /\)\s*(ENGINE\s*=\s*[^;]+)/i.exec(sql);
    return match ? match[1].trim() : null;
}

// A tail as comparable KEY=VALUE pairs: DEFAULT is noise (`DEFAULT CHARSET=x` and `CHARSET=x`
// are one DDL), CHARACTER SET is CHARSET, and case is not significant.
function tailPairs(tail) {
    const norm = String(tail).toUpperCase().replace(/\bDEFAULT\b/g, ' ').replace(/CHARACTER\s+SET/g, 'CHARSET');
    const pairs = {};
    for (const [, key, value] of norm.matchAll(/(\w+)\s*=\s*(\w+)/g)) pairs[key] = value;
    return pairs;
}

// The `key=value` pairs a current tail carries that the pinned tail does not, plus a pinned
// pair the current tail dropped (reported as KEY=<absent>).
function movedPairs(origin, current) {
    const was = tailPairs(origin);
    const now = tailPairs(current);
    const moved = [];
    for (const key of Object.keys(now)) if (was[key] !== now[key]) moved.push([key, now[key]]);
    for (const key of Object.keys(was)) if (!(key in now)) moved.push([key, null]);
    return moved;
}

// Every ALTER TABLE statement a migration set directs at `table`, upper-cased.
function alterStatements(table, migrationTexts) {
    const re = new RegExp('ALTER\\s+TABLE\\s+`?' + table + '`?\\s[^;]*;', 'gi');
    return migrationTexts.flatMap((text) => (text.match(re) || []).map((s) => s.toUpperCase()));
}

// Tables whose current tail moved off the pinned origin tail with no migration naming the move.
function unmigratedTails({ origin, current, migrationTexts }) {
    const bad = [];
    for (const table of Object.keys(origin).sort()) {
        const moved = movedPairs(origin[table], current[table]);
        if (!moved.length) continue;
        const statements = alterStatements(table, migrationTexts);
        const named = moved.every(([, value]) => value !== null && statements.some((s) => new RegExp('\\b' + value + '\\b').test(s)));
        if (!named) bad.push(table + ': ' + moved.map(([k, v]) => k + '=' + v).join(' '));
    }
    return bad;
}

function currentTails(tables) {
    return Object.fromEntries(tables.map((table) => [table, definitionTail(fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8'))]));
}

describe('SQL schema column parity (table tail) @regression', function () {
    const origin = () => loadPinnedOriginFixture(TAIL_ORIGIN, ORIGIN_TAIL_SHA256, CONSUMER).tails;

    it('the tail anchor covers exactly the pre-ledger tables of the column anchor', function () {
        const columns = loadPinnedOriginFixture(ORIGIN_BASELINE, ORIGIN_BASELINE_SHA256, CONSUMER).baseline;
        assert.ok(Object.keys(columns).length > 0, 'the column anchor carries no table, so this guard checks nothing');
        assert.deepStrictEqual(Object.keys(origin()).sort(), Object.keys(columns).sort());
    });

    it('every pre-ledger definition keeps its pinned tail unless a dated migration names the move', function () {
        const tails = origin();
        const migrationTexts = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
            .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
        const current = currentTails(Object.keys(tails));
        for (const table of Object.keys(tails)) assert.ok(current[table], table + '.sql declares no ENGINE tail');
        assert.deepStrictEqual(unmigratedTails({ origin: tails, current, migrationTexts }), []);
    });

    it('the anchor keeps the one non-default tail the consensus reads depend on', function () {
        const pairs = tailPairs(origin().index_tickers);
        assert.strictEqual(pairs.CHARSET, 'UTF8MB4');
        assert.strictEqual(pairs.COLLATE, 'UTF8MB4_BIN');
    });
});

describe('SQL schema column parity (table tail): the guard bites @regression', function () {
    const ORIGIN = { t: 'ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci' };
    const check = (tail, migrationTexts) => unmigratedTails({ origin: ORIGIN, current: { t: tail }, migrationTexts });

    it('spelling and spacing of an unchanged tail are not a move', function () {
        assert.deepStrictEqual(check('ENGINE=InnoDB  CHARSET=utf8 COLLATE=utf8_general_ci', []), []);
        assert.deepStrictEqual(check('engine=innodb default character set=utf8 collate=utf8_general_ci', []), []);
    });

    it('a charset or collation edit with no migration is flagged', function () {
        assert.deepStrictEqual(check('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci', []),
            ['t: CHARSET=UTF8MB4 COLLATE=UTF8MB4_GENERAL_CI']);
    });

    it('a ROW_FORMAT or engine edit with no migration is flagged', function () {
        assert.strictEqual(check('ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci ROW_FORMAT=DYNAMIC', []).length, 1);
        assert.strictEqual(check('ENGINE=Aria DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci', []).length, 1);
    });

    it('a dropped pinned pair is flagged even when a migration exists', function () {
        const migration = 'ALTER TABLE `t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;';
        assert.strictEqual(check('ENGINE=InnoDB COLLATE=utf8_general_ci', [migration]).length, 1);
    });

    it('a migration that converts the table to every moved value clears the edit', function () {
        const migration = '-- note\nALTER TABLE `t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;\n';
        assert.deepStrictEqual(check('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci', [migration]), []);
    });

    it('a migration that names only part of the move, or another table, does not clear it', function () {
        const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
        assert.strictEqual(check(tail, ['ALTER TABLE `t` CONVERT TO CHARACTER SET utf8mb4;']).length, 1);
        assert.strictEqual(check(tail, ['ALTER TABLE `other` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;']).length, 1);
    });
});

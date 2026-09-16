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
 * Schema migration runner: pure-logic contract tests (no live DB).
 *
 * Covers the gate that decides whether a migration runs unattended at startup:
 * migrationMode() header parsing, and the invariant that every committed migration
 * declares its intent explicitly so a destructive file can never default-silently
 * into the auto-apply path on a validator fleet.
 *
 ********************************************************************/

const { assert, fs, path, Database, modeOf, destructiveOf, statementsOf } = require('./helpers/migration_fixtures.js');


describe('Database.backdatedFrontierViolation() @regression @tier1', function () {
    it('reports the frontier when a pending file is dated before an applied one', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-07-01-late-add.sql',
                ['2026-06-10-a.sql', '2026-08-10-b.sql']),
            '2026-08-10-b.sql');
    });

    it('stays silent for a pending file dated after everything applied', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-08-11-new.sql',
                ['2026-06-10-a.sql', '2026-08-10-b.sql']),
            null);
    });

    it('never trips on a fresh install (empty ledger)', function () {
        assert.strictEqual(Database.backdatedFrontierViolation('2026-01-01-first.sql', []), null);
        assert.strictEqual(Database.backdatedFrontierViolation('2026-01-01-first.sql', null), null);
    });

    it('accepts a Map keys() iterator, which is what the apply loop passes', function () {
        const applied = new Map([['2026-06-10-a.sql', 'h1'], ['2026-08-10-b.sql', 'h2']]);
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-07-01-late-add.sql', applied.keys()),
            '2026-08-10-b.sql');
    });

    it('compares against the MAXIMUM applied name, not the last one seen', function () {
        // Ledger rows arrive in whatever order the SELECT returns them.
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-07-01-late-add.sql',
                ['2026-08-10-b.sql', '2026-06-10-a.sql']),
            '2026-08-10-b.sql');
    });

    it('treats an equal name as applied, not backdated', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-08-10-b.sql', ['2026-08-10-b.sql']),
            null);
    });

    // An undated ledger name sorts ABOVE every 2026-* name in ASCII ('a' 0x61 > '2'
    // 0x32), so an unfiltered maximum makes the frontier a garbage value that every
    // ordinary new migration sorts below. add_controller_bound_token_columns.sql is
    // the real instance: added in 7f1142e, DELETED in 1c728c5 rather than renamed, so
    // MIGRATION_LEDGER_RENAMES cannot heal it and any DB migrated inside that window
    // carries the row forever.
    it('ignores an undated legacy ledger row when computing the frontier', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-08-11-new.sql', [
                '2026-05-30-balances-composite-index.sql',
                'add_controller_bound_token_columns.sql',
                '2026-08-10-bet-cancel-resolve-standalone-indexes.sql',
            ]),
            null,
            'an undated legacy row must never become the frontier');
    });
});

describe('Database.backdatedFrontierViolation() @regression @tier1', function () {
    it('still reports a real violation when an undated legacy row is present', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-07-01-late-add.sql', [
                'add_controller_bound_token_columns.sql',
                '2026-08-10-bet-cancel-resolve-standalone-indexes.sql',
            ]),
            '2026-08-10-bet-cancel-resolve-standalone-indexes.sql',
            'the filter must narrow the frontier, not disable the guard');
    });

    it('never trips when the ledger holds only undated legacy rows', function () {
        assert.strictEqual(
            Database.backdatedFrontierViolation('2026-01-01-first.sql',
                ['add_controller_bound_token_columns.sql', 'unique_full_column_index_addresses.sql']),
            null);
    });

    it('every committed migration is clean against a ledger of all its predecessors', function () {
        // The guard must not fire on the shipped tree: each file, checked against
        // everything that sorts before it, is by construction at or after the frontier.
        const dir   = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
        files.forEach(function (file, i) {
            assert.strictEqual(Database.backdatedFrontierViolation(file, files.slice(0, i)), null,
                file + ' must not sort before any migration committed before it');
        });
    });
});

const splitOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);

describe('Database.splitSqlStatements() @regression @tier1', function () {
    it('does not split on a ; inside a single-quoted string literal', function () {
        assert.deepStrictEqual(splitOf("UPDATE t SET data = 'a;b' WHERE id = 1;"),
            ["UPDATE t SET data = 'a;b' WHERE id = 1"]);
    });

    it('does not split on a ; inside double-quoted or backtick-quoted spans', function () {
        assert.deepStrictEqual(splitOf('UPDATE t SET data = "a;b" WHERE id = 1;'),
            ['UPDATE t SET data = "a;b" WHERE id = 1']);
        assert.deepStrictEqual(splitOf('UPDATE `we;ird` SET x = 1;'),
            ['UPDATE `we;ird` SET x = 1']);
    });

    it('treats doubled quotes as escapes (a ; inside stays inside)', function () {
        assert.deepStrictEqual(splitOf("INSERT INTO t (m) VALUES ('it''s; fine');"),
            ["INSERT INTO t (m) VALUES ('it''s; fine')"]);
    });

    it('does not split on a ; inside a -- line comment', function () {
        assert.deepStrictEqual(splitOf('SELECT 1; -- trailing; note\nSELECT 2;'),
            ['SELECT 1', 'SELECT 2']);
    });

    it('does not split on a ; inside a # line comment, and drops the comment', function () {
        assert.deepStrictEqual(splitOf('SELECT 1; # see foo; bar\nSELECT 2;'),
            ['SELECT 1', 'SELECT 2']);
    });

    it('strips a leading # comment so the next statement classifies on its own keyword', function () {
        assert.deepStrictEqual(splitOf('# tidy legacy rows\nDROP TABLE balances;'),
            ['DROP TABLE balances']);
    });

    it('leaves a # inside a block comment or a quoted span alone', function () {
        // A naive #-to-end-of-line strip would eat the closing */ and the rest of the line.
        assert.deepStrictEqual(splitOf('/* see issue #4373 */ SELECT 1;'),
            ['/* see issue #4373 */ SELECT 1']);
        assert.deepStrictEqual(splitOf("INSERT INTO t (m) VALUES ('#tag; still one');"),
            ["INSERT INTO t (m) VALUES ('#tag; still one')"]);
    });

    it('does not let an apostrophe in block-comment prose open a quote span', function () {
        // The scanner used to read `don't` as a quote start, swallowing the ';'.
        assert.deepStrictEqual(splitOf("/* don't do this */ SELECT 1; SELECT 2;"),
            ["/* don't do this */ SELECT 1", 'SELECT 2']);
    });

    it('a `#` comment cannot hide a DROP from the destructive-DDL guard', function () {
        const offender = destructiveOf(splitOf('# cleanup\nDROP TABLE balances;'));
        assert.ok(offender && /DROP TABLE balances/i.test(offender));
    });

    it('splits ordinary multi-statement SQL into the same statements as before', function () {
        assert.deepStrictEqual(splitOf('CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);'),
            ['CREATE TABLE a (id INT)', 'CREATE TABLE b (id INT)']);
    });
});

describe('Database.splitSqlStatements() @regression @tier1', function () {
    it('guard classifies real statements, not fragments (both directions)', function () {
        // A ;DROP TABLE buried in a string literal is ONE non-destructive statement.
        assert.strictEqual(destructiveOf(splitOf(
            "INSERT INTO notes (body) VALUES ('watch for ;DROP TABLE x');"
        )), null);
        // A genuine trailing DROP TABLE is still caught.
        const offender = destructiveOf(splitOf(
            "INSERT INTO notes (body) VALUES ('ok'); DROP TABLE x;"
        ));
        assert.ok(offender && /DROP TABLE x/i.test(offender));
    });
});

describe('committed mode=auto migrations contain no destructive DDL @regression @tier1', function () {
    const MIG_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');
    let files = [];
    try { files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')); } catch (e) { /* none */ }

    files.forEach(function (file) {
        it(file + ': if tagged mode=auto, passes the destructive-DDL scan', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            if (modeOf(raw) !== 'auto') return; // manual files are operator-gated by design
            const offender = destructiveOf(statementsOf(raw));
            assert.strictEqual(offender, null,
                file + ' is tagged mode=auto but contains destructive DDL: "' + String(offender).slice(0, 120) +
                '". Re-tag it mode=manual (applied via `node src/db/migration/migrate.js`) - a destructive ' +
                'statement must never auto-run unattended against validator DBs.');
        });
    });
});

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
 * _migrationMode() header parsing, and the invariant that every committed migration
 * declares its intent explicitly so a destructive file can never default-silently
 * into the auto-apply path on a validator fleet.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

// _migrationMode is a pure string function : bind it to a bare object.
const modeOf = Database.prototype._migrationMode.bind({});

// Destructive-DDL guard helpers: same comment-strip + quote-aware split runMigrations uses.
// Bind to the prototype so _destructiveAutoStatement can reach _isIdRepairUpdate and
// splitSqlStatements can reach stripSqlLineComments (both pure, no instance state).
const stripComments = Database.prototype.stripSqlLineComments.bind({});
const destructiveOf = Database.prototype._destructiveAutoStatement.bind(Database.prototype);
const statementsOf  = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);

describe('Database._migrationMode() @regression @tier1', function () {

    it('reads mode=auto from the header tag', function () {
        assert.strictEqual(modeOf('-- xchain:migration mode=auto\nALTER TABLE x ADD COLUMN y INT;'), 'auto');
    });

    it('reads mode=manual from the header tag', function () {
        assert.strictEqual(modeOf('-- xchain:migration mode=manual\nDROP INDEX z ON x;'), 'manual');
    });

    it('defaults to manual when no tag is present (never auto-runs unknown DDL)', function () {
        assert.strictEqual(modeOf('-- just a normal migration comment\nALTER TABLE x ADD COLUMN y INT;'), 'manual');
    });

    it('is case-insensitive and tolerant of spacing', function () {
        assert.strictEqual(modeOf('--   XChain:Migration   mode = AUTO  (additive)\n'), 'auto');
    });

    it('only honors the tag on a comment line, and a non-auto/manual value falls through to manual', function () {
        assert.strictEqual(modeOf('-- xchain:migration mode=yolo\n'), 'manual');
    });

    it('ignores a mode= tag below the first SQL statement (body prose cannot arm auto)', function () {
        // A file whose real header omits the tag (defaults manual), with a spoofed
        // `mode=auto` buried below a real SQL statement in trailing prose or a data
        // literal. The scan is prologue-anchored - it stops at the first non-comment,
        // non-blank line - so a tag past the first statement can never arm the
        // auto-apply path for a destructive migration.
        const body = 'ALTER TABLE events ADD COLUMN note TEXT;\n' +
                     '-- xchain:migration mode=auto (trailing prose)\n' +
                     'DROP TABLE events;\n';
        assert.strictEqual(modeOf(body), 'manual');
    });

    it('reads mode=auto from a tag under a multi-line license banner', function () {
        // The house layout puts the license banner first and the mode tag after it,
        // pushing the tag well past the old 10-line window. The prologue scan reads
        // the whole leading comment run, so a banner-prefixed mode=auto still arms.
        let banner = '';
        for(let i = 0; i < 13; i++) banner += '-- license banner line ' + i + '\n';
        const raw = banner + '\n-- xchain:migration mode=auto\nALTER TABLE x ADD COLUMN y INT;';
        assert.strictEqual(modeOf(raw), 'auto');
    });
});

describe('committed migrations declare intent @regression @tier1', function () {
    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');
    let files = [];
    try { files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')); } catch (e) { /* none */ }

    it('migrations directory is present', function () {
        assert.ok(fs.existsSync(MIG_DIR), 'expected ' + MIG_DIR);
    });

    files.forEach(function (file) {
        it(file + ': carries an explicit `-- xchain:migration mode=auto|manual` tag the runner sees', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            // Match the tag ANYWHERE in the file, then assert the runner's prologue-anchored
            // _migrationMode actually resolves it to that declared value. This asserts the runner
            // and the declared intent agree, so a tag the runner cannot see (e.g. below the first
            // SQL statement) fails CI instead of default-landing as `manual` while looking tagged
            // (the dead-tag gap this test exists to catch, ).
            const anywhere = raw.match(/--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
            assert.ok(anywhere,
                file + ' has no explicit mode tag. Every migration must declare intent so a ' +
                'destructive change can never silently auto-run at startup. Add a first line ' +
                '(or place it anywhere in the leading comment prologue): ' +
                '`-- xchain:migration mode=auto` (additive + idempotent) or `mode=manual` (gated).');
            const declared = anywhere[1].toLowerCase();
            assert.strictEqual(modeOf(raw), declared,
                file + ' declares mode=' + declared + ' but _migrationMode reads it as ' + modeOf(raw) +
                ' - the tag sits where the runner cannot see it (it must be in the leading comment ' +
                'prologue, before the first SQL statement).');
        });
    });

    // The runner applies migrations in `readdirSync(...).sort()` order (src/db.js),
    // so a `YYYY-MM-DD-` filename prefix is what guarantees authorship-order apply.
    // The convention is now enforced with NO exemptions: the three legacy undated
    // files were renamed to their authored dates (paired with a ledger rename heal),
    // and runMigrations throws on any undated filename.
    const DATED_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
    files.forEach(function (file) {
        it(file + ': uses the dated YYYY-MM-DD- filename prefix (ordering convention)', function () {
            assert.ok(DATED_PREFIX.test(file),
                file + ' is not dated. Runner apply order is readdirSync().sort(), so every ' +
                'migration must start with a `YYYY-MM-DD-` prefix to apply in authorship order. ' +
                'Rename it with the authored date (no undated files are allowed).');
        });
    });
});

describe('legacy migration rename: ledger remap + ordering @regression @tier1', function () {
    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');
    const RENAMES = Database.MIGRATION_LEDGER_RENAMES;

    it('the three legacy undated names are mapped to dated targets', function () {
        assert.deepStrictEqual(Object.keys(RENAMES).sort(), [
            'add_balances_composite_index.sql',
            'add_cross_chain_matches_partial_fill_columns.sql',
            'unique_full_column_index_addresses.sql'
        ]);
        Object.values(RENAMES).forEach(function (name) {
            assert.ok(/^\d{4}-\d{2}-\d{2}-/.test(name), name + ' must be dated');
        });
    });

    it('every dated target exists on disk and no old undated file remains', function () {
        Object.entries(RENAMES).forEach(function ([oldName, newName]) {
            assert.ok(fs.existsSync(path.join(MIG_DIR, newName)), 'expected renamed file ' + newName);
            assert.ok(!fs.existsSync(path.join(MIG_DIR, oldName)), oldName + ' should have been renamed away');
        });
    });

    it('planLedgerRenames re-keys an old-name-applied database', function () {
        // A DB migrated before the rename recorded the OLD undated names.
        const applied = ['2026-06-16-drop-orphaned-contract-balances.sql'].concat(Object.keys(RENAMES));
        const ops = Database.planLedgerRenames(applied);
        assert.strictEqual(ops.length, 3, 'all three legacy rows should be re-keyed');
        const byFrom = new Map(ops.map(o => [o.from, o.to]));
        Object.entries(RENAMES).forEach(function ([oldName, newName]) {
            assert.strictEqual(byFrom.get(oldName), newName);
        });
    });

    it('planLedgerRenames is a no-op on a fresh database (nothing applied yet)', function () {
        assert.deepStrictEqual(Database.planLedgerRenames([]), []);
    });

    it('planLedgerRenames is a no-op on a database already re-keyed (idempotent)', function () {
        // Rows already recorded under the NEW dated names must not be re-keyed again.
        const applied = Object.values(RENAMES);
        assert.deepStrictEqual(Database.planLedgerRenames(applied), []);
    });

    it('does not re-key a legacy row when its dated target is already present', function () {
        // Mixed state: one row still old, but its target already recorded -> skip that one.
        const applied = [
            'add_balances_composite_index.sql',
            '2026-05-30-balances-composite-index.sql'
        ];
        assert.deepStrictEqual(Database.planLedgerRenames(applied), []);
    });

    it('apply order is now lexical = chronological (renamed files land in date order)', function () {
        let files = [];
        try { files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort(); } catch (e) { /* none */ }
        // Every file is dated, and lexical sort of YYYY-MM-DD- prefixes is chronological.
        const dates = files.map(f => f.slice(0, 10));
        const ascending = dates.slice().sort();
        assert.deepStrictEqual(dates, ascending, 'files must sort in ascending date order');
        // The three renamed files must precede the dated migration that assumes their
        // schema state (2026-07-07-cross-chain-matches-payout-legs.sql).
        const payoutIdx = files.indexOf('2026-07-07-cross-chain-matches-payout-legs.sql');
        Object.values(RENAMES).forEach(function (name) {
            const idx = files.indexOf(name);
            assert.ok(idx >= 0 && idx < payoutIdx, name + ' must sort before the payout-legs migration');
        });
    });
});

describe('Database._destructiveAutoStatement() @regression @tier1', function () {

    // ── flagged: statements that can lose, truncate, or rename data ──────

    it('flags DROP TABLE', function () {
        assert.ok(destructiveOf(['DROP TABLE contract_stakes']));
    });

    it('flags DROP DATABASE / DROP SCHEMA', function () {
        assert.ok(destructiveOf(['DROP DATABASE indexer']));
        assert.ok(destructiveOf(['DROP SCHEMA indexer']));
    });

    it('flags TRUNCATE', function () {
        assert.ok(destructiveOf(['TRUNCATE TABLE validator_rewards']));
    });

    it('flags CREATE OR REPLACE TABLE (atomic DROP+CREATE wipes rows) but not plain/IF NOT EXISTS', function () {
        assert.ok(destructiveOf(['CREATE OR REPLACE TABLE balances (id BIGINT) ENGINE=InnoDB']));
        assert.ok(destructiveOf(['CREATE OR REPLACE TEMPORARY TABLE t (id INT)']));
        // Additive create forms stay safe (must not false-positive and block fleet boot).
        assert.strictEqual(destructiveOf(['CREATE TABLE IF NOT EXISTS balances (id BIGINT) ENGINE=InnoDB']), null);
        assert.strictEqual(destructiveOf(['CREATE TABLE new_thing (id BIGINT) ENGINE=InnoDB']), null);
    });

    it('flags RENAME TABLE', function () {
        assert.ok(destructiveOf(['RENAME TABLE old_name TO new_name']));
    });

    it('flags DELETE FROM (destructive DML has no place in an auto migration)', function () {
        assert.ok(destructiveOf(['DELETE FROM balances WHERE amount = 0']));
    });

    it('flags non-canonical DELETE forms that omit an immediate FROM', function () {
        // Every DELETE removes rows; the guard must not depend on `DELETE FROM` word order.
        assert.ok(destructiveOf(['DELETE LOW_PRIORITY FROM balances WHERE amount = 0']));
        assert.ok(destructiveOf(['DELETE IGNORE FROM balances WHERE amount = 0']));
        assert.ok(destructiveOf(['DELETE t1 FROM balances t1 JOIN blocks t2 ON t1.block_index=t2.block_index']));
    });

    it('flags ALTER TABLE ... DROP COLUMN', function () {
        assert.ok(destructiveOf(['ALTER TABLE tokens DROP COLUMN legacy_flag']));
    });

    it('flags ALTER TABLE with a bare column DROP (no COLUMN keyword)', function () {
        assert.ok(destructiveOf(['ALTER TABLE tokens DROP legacy_flag']));
        assert.ok(destructiveOf(['ALTER TABLE tokens DROP `legacy_flag`']));
    });

    it('flags ALTER TABLE ... DROP PARTITION (rows in the partition are lost)', function () {
        assert.ok(destructiveOf(['ALTER TABLE events DROP PARTITION p2025']));
    });

    it('flags ALTER TABLE ... RENAME TO / RENAME COLUMN', function () {
        assert.ok(destructiveOf(['ALTER TABLE tokens RENAME TO tokens_v2']));
        assert.ok(destructiveOf(['ALTER TABLE tokens RENAME COLUMN tick TO ticker']));
    });

    it('flags ALTER TABLE ... CHANGE (rename + retype in one clause)', function () {
        assert.ok(destructiveOf(['ALTER TABLE tokens CHANGE COLUMN tick ticker VARCHAR(32)']));
    });

    it('flags MODIFY ... NOT NULL (statically detectable narrowing)', function () {
        assert.ok(destructiveOf(['ALTER TABLE tokens MODIFY COLUMN tick VARCHAR(250) NOT NULL']));
    });

    it('a destructive statement hiding behind a safe one is still flagged', function () {
        assert.ok(destructiveOf([
            'ALTER TABLE votes DROP INDEX IF EXISTS poll_voter_choice',
            'DROP TABLE contract_stakes'
        ]));
    });

    // ── dynamic-SQL / stored-routine indirection must be flagged ─────────

    it('flags PREPARE (dynamic SQL the prefix scanner cannot see)', function () {
        assert.ok(destructiveOf(["PREPARE stmt FROM @s"]));
    });

    it('flags EXECUTE of a prepared statement', function () {
        assert.ok(destructiveOf(['EXECUTE stmt']));
    });

    it('flags CALL of a stored routine (body is opaque to the scanner)', function () {
        assert.ok(destructiveOf(['CALL some_proc()']));
    });

    it('flags SET of a user variable staging dynamic SQL', function () {
        assert.ok(destructiveOf(["SET @s = 'DROP TABLE balances'"]));
    });

    it('flags the full SET @/PREPARE/EXECUTE dynamic-SQL bypass end to end', function () {
        const raw = '-- xchain:migration mode=auto\n' +
            "SET @s = 'DROP TABLE balances';\n" +
            'PREPARE stmt FROM @s;\n' +
            'EXECUTE stmt;\n';
        assert.strictEqual(modeOf(raw), 'auto');
        assert.ok(destructiveOf(statementsOf(raw)));
    });

    it('does NOT flag benign system-variable SETs (SET NAMES / SET sql_mode / SET @@)', function () {
        assert.strictEqual(destructiveOf(['SET NAMES utf8mb4']), null);
        assert.strictEqual(destructiveOf(['SET sql_mode = "STRICT_ALL_TABLES"']), null);
        assert.strictEqual(destructiveOf(['SET @@session.foreign_key_checks = 0']), null);
    });

    // ── allowed: legitimate existing auto patterns must NOT be flagged ───

    it('allows DROP INDEX / DROP KEY inside ALTER (idempotent drop+recreate pattern)', function () {
        assert.strictEqual(destructiveOf(['ALTER TABLE votes DROP INDEX IF EXISTS poll_voter_choice']), null);
        assert.strictEqual(destructiveOf(['ALTER TABLE attests DROP KEY request_id_version']), null);
    });

    it('allows structural metadata drops (FOREIGN KEY / CONSTRAINT / PRIMARY KEY / DEFAULT)', function () {
        assert.strictEqual(destructiveOf(['ALTER TABLE a DROP FOREIGN KEY fk_b']), null);
        assert.strictEqual(destructiveOf(['ALTER TABLE a DROP CONSTRAINT chk_positive']), null);
        assert.strictEqual(destructiveOf(['ALTER TABLE a DROP PRIMARY KEY, ADD PRIMARY KEY (id, seq)']), null);
        assert.strictEqual(destructiveOf(['ALTER TABLE a ALTER COLUMN x DROP DEFAULT']), null);
    });

    it('allows ADD COLUMN (including NOT NULL with a default) and CREATE INDEX', function () {
        assert.strictEqual(destructiveOf(['ALTER TABLE tokens ADD COLUMN block_index_doge INT NULL']), null);
        assert.strictEqual(destructiveOf(['ALTER TABLE t ADD COLUMN n INT NOT NULL DEFAULT 0']), null);
        assert.strictEqual(destructiveOf(['CREATE INDEX idx_block ON blocks (block_index)']), null);
    });

    it('allows widening MODIFY (nullable, no NOT NULL)', function () {
        assert.strictEqual(destructiveOf(['ALTER TABLE t MODIFY COLUMN memo MEDIUMTEXT NULL']), null);
    });

    it('allows a MODIFY ... NOT NULL AUTO_INCREMENT attribute repair (AUTO_INCREMENT implies NOT NULL)', function () {
        assert.strictEqual(destructiveOf(['ALTER TABLE price_snapshots MODIFY id BIGINT NOT NULL AUTO_INCREMENT']), null);
    });

    it('flags a NOT NULL-narrowing clause even when a sibling clause is AUTO_INCREMENT', function () {
        // Per-clause check: one AUTO_INCREMENT clause must not exempt a sibling
        // NOT NULL narrowing in the same multi-clause ALTER.
        assert.ok(destructiveOf([
            'ALTER TABLE t MODIFY id BIGINT NOT NULL AUTO_INCREMENT, MODIFY source VARCHAR(255) NOT NULL'
        ]));
    });

    it('flags REPLACE INTO (atomic DELETE+INSERT wipes existing-key rows)', function () {
        assert.ok(destructiveOf(['REPLACE INTO balances (address, amount) VALUES (?, ?)']));
    });

    it('flags a bare UPDATE that rewrites row data', function () {
        assert.ok(destructiveOf(['UPDATE balances SET amount = 0 WHERE amount < 10']));
    });

    it('allows the committed AUTO_INCREMENT id=0 repair UPDATE, but not other id UPDATEs', function () {
        assert.strictEqual(destructiveOf([
            'UPDATE price_snapshots\n   SET id = (SELECT next_id FROM (SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM price_snapshots) t)\n WHERE id = 0'
        ]), null);
        assert.ok(destructiveOf(['UPDATE price_snapshots SET id = 5 WHERE id = 0']));
    });

    it('flags UPDATE bypasses that smuggle past the id-repair carve-out', function () {
        // The old carve-out regex was unanchored and paren-greedy; these both slipped
        // through and rewrote every row. They must now be flagged (#1861).
        // (a) trailing clause after WHERE id = 0
        assert.ok(destructiveOf(['UPDATE balances SET id = (SELECT 1) WHERE id = 0 OR 1=1']));
        // (b) a second, data-destroying SET assignment riding inside the id-repair shape
        assert.ok(destructiveOf(["UPDATE balances SET id = (SELECT id), amount = (SELECT '0') WHERE id = 0"]));
        // (c) a trailing LIMIT after the id=0 predicate
        assert.ok(destructiveOf(['UPDATE balances SET id = (SELECT 1) WHERE id = 0 LIMIT 1']));
    });

    it('still allows the nested-subquery id repair after the carve-out is tightened', function () {
        // The balanced-paren matcher must not reject the committed repair shape, whose
        // subquery contains nested parens and commas (a naive "no commas" rule would).
        assert.strictEqual(destructiveOf([
            'UPDATE price_snapshots\n   SET id = (SELECT next_id FROM (SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM price_snapshots) t)\n WHERE id = 0'
        ]), null);
        // Backtick-quoted table name, trailing semicolon, and WHERE id = 0 still pass.
        assert.strictEqual(destructiveOf([
            'UPDATE `balances` SET id = (SELECT 1) WHERE id = 0;'
        ]), null);
    });

    it('allows RENAME INDEX/KEY (metadata-only rename)', function () {
        assert.strictEqual(destructiveOf(['ALTER TABLE t RENAME INDEX old_idx TO new_idx']), null);
    });

    it('a destructive keyword inside a comment does not trigger', function () {
        // Line comments are stripped by the runner before the scan; block comments
        // are stripped by the scanner itself.
        assert.strictEqual(destructiveOf(statementsOf(
            '-- xchain:migration mode=auto\n' +
            '-- NOTE: an earlier draft used DROP TABLE here\n' +
            'ALTER TABLE t /* never DROP COLUMN in auto */ ADD COLUMN y INT NULL;'
        )), null);
    });

    it('the canonical trigger case: mode=auto file with DROP TABLE is caught end to end', function () {
        const raw = '-- xchain:migration mode=auto\nDROP TABLE contract_stakes;\n';
        assert.strictEqual(modeOf(raw), 'auto');
        const offender = destructiveOf(statementsOf(raw));
        assert.ok(offender && /DROP TABLE contract_stakes/i.test(offender));
    });

    // ── executable (versioned) comments: the server RUNS these ───────────

    it('flags a MySQL-versioned executable comment (/*!nnnnn ... */)', function () {
        assert.ok(destructiveOf(['/*!50000 DROP TABLE balances */']));
        assert.ok(destructiveOf(['/*!40000 TRUNCATE balances */']));
    });

    it('flags a MariaDB-only executable comment (/*M! ... */)', function () {
        assert.ok(destructiveOf(['/*M! DROP TABLE balances */']));
        assert.ok(destructiveOf(['/*M!100300 DROP TABLE balances */']));
    });

    it('flags an executable comment riding inside an otherwise-additive statement', function () {
        assert.ok(destructiveOf(['ALTER TABLE t ADD COLUMN y INT NULL /*!50000, DROP COLUMN x */']));
    });

    it('the executable-comment bypass is caught end to end from raw file text', function () {
        const raw = '-- xchain:migration mode=auto\n/*!50000 DROP TABLE balances */;\n';
        assert.strictEqual(modeOf(raw), 'auto');
        const offender = destructiveOf(statementsOf(raw));
        assert.ok(offender && /DROP TABLE balances/i.test(offender),
            'the versioned comment payload must reach the classifier, not be stripped before it');
    });

    it('a plain (non-executable) block comment still does not trigger', function () {
        assert.strictEqual(destructiveOf(['CREATE TABLE foo (id INT) /* DROP TABLE bar */']), null);
        assert.strictEqual(destructiveOf(['CREATE TABLE foo (id INT)']), null);
    });
});

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
        const dir   = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
        files.forEach(function (file, i) {
            assert.strictEqual(Database.backdatedFrontierViolation(file, files.slice(0, i)), null,
                file + ' must not sort before any migration committed before it');
        });
    });
});

describe('Database.splitSqlStatements() @regression @tier1', function () {
    const splitOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);

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

    it('splits ordinary multi-statement SQL into the same statements as before', function () {
        assert.deepStrictEqual(splitOf('CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);'),
            ['CREATE TABLE a (id INT)', 'CREATE TABLE b (id INT)']);
    });

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
    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');
    let files = [];
    try { files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')); } catch (e) { /* none */ }

    files.forEach(function (file) {
        it(file + ': if tagged mode=auto, passes the destructive-DDL scan', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            if (modeOf(raw) !== 'auto') return; // manual files are operator-gated by design
            const offender = destructiveOf(statementsOf(raw));
            assert.strictEqual(offender, null,
                file + ' is tagged mode=auto but contains destructive DDL: "' + String(offender).slice(0, 120) +
                '". Re-tag it mode=manual (applied via `node src/migrate.js`) - a destructive ' +
                'statement must never auto-run unattended against validator DBs.');
        });
    });
});

describe('Database.MIGRATION_CHECKSUM_REBASELINES @regression @tier1', function () {

    const crypto  = require('crypto');
    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');

    it('every rebaseline pins a `to` and one or more distinct 64-hex sha256 `from` values', function () {
        // `from` may be a single hash or a list of hashes (one reviewed edit can supersede
        // several historical revisions). Normalize with [].concat and validate every element.
        for (const [file, r] of Object.entries(Database.MIGRATION_CHECKSUM_REBASELINES)) {
            const fromList = [].concat(r.from);
            assert.ok(fromList.length >= 1, file + ': from must have at least one hash');
            assert.strictEqual(new Set(fromList).size, fromList.length, file + ': from hashes must be unique');
            assert.match(r.to, /^[0-9a-f]{64}$/, file + ': to must be a sha256 hex digest');
            for (const from of fromList) {
                assert.match(from, /^[0-9a-f]{64}$/, file + ': every from must be a sha256 hex digest');
                assert.notStrictEqual(from, r.to, file + ': from and to must differ');
            }
        }
    });

    it('every rebaseline `to` hash matches the committed file content (heals TOWARD the repo, never away from it)', function () {
        for (const [file, r] of Object.entries(Database.MIGRATION_CHECKSUM_REBASELINES)) {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const checksum = crypto.createHash('sha256').update(raw).digest('hex');
            assert.strictEqual(checksum, r.to,
                file + ': rebaseline target is stale - it must equal the current committed file sha256, ' +
                'otherwise the heal path would rewrite the ledger to a hash that still mismatches.');
        }
    });

    // . The two legacy migrations that were renamed AND carry their own filename in
    // a HOW TO RUN comment: the rename edited that comment, the ledger rename heal carried
    // the pre-rename checksum across, and every prod indexer logged `content CHANGED` for
    // them on every start. Pin the predecessor hashes so a real migration edit is loud again.
    const XC805 = {
        '2026-06-03-unique-full-column-index-addresses.sql': [
            '9fdbbcbda36b860a3214d5fcc3d057f3bdf413a99c9d5407e7ef9951a318fb1e',
            '8193fe4eca04ac802b5963a7f3b100bf2b3f3103aaeb18e8eb5ff88b8f5f557d',
        ],
        '2026-06-09-cross-chain-matches-partial-fill-columns.sql': [
            '289d9fe5fb41f8012e7cbcdb3d6c2e2a8c983ca84afd920d73b386a33d64e602',
            '7fe66226c936023b72121c24fb3cfbea5bd4e52e70964542a6617f12b2a74451',
        ],
    };

    Object.entries(XC805).forEach(function ([file, expected]) {
        it(file + ': heals from both its pre-rename and its license-header revision', function () {
            const r = Database.MIGRATION_CHECKSUM_REBASELINES[file];
            assert.ok(r, file + ' must have a rebaseline entry - without it the immutability ' +
                'guard fires on every indexer start and can no longer flag a genuine edit.');
            const fromList = [].concat(r.from);
            expected.forEach(function (hash) {
                assert.ok(fromList.includes(hash),
                    file + ': recorded revision ' + hash.slice(0, 12) + ' is not covered by the ' +
                    'rebaseline, so DBs that applied it keep logging content CHANGED.');
            });
        });
    });
});

// End-to-end over the runner's mismatch branch itself, against a stubbed connection:
// the pinned-predecessor case must re-key the ledger row and stay silent, while any
// other divergence must still be reported. This is what "restart an indexer and see
// zero `content CHANGED` lines" checks, minus the live DB.
describe('runMigrations() checksum heal branch @regression @tier1', function () {

    const crypto  = require('crypto');
    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');

    const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const fileChecksums = () => {
        const out = new Map();
        for (const f of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))) {
            out.set(f, sha256(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')));
        }
        return out;
    };

    // Runs runMigrations against a fake connection seeded with `ledger` (name -> checksum),
    // capturing every UPDATE and every console line. Nothing is applied: the ledger passed
    // in always covers every file on disk, so the runner only walks the compare branch.
    async function runAgainst(ledger) {
        const updates = [];
        const logged  = [];
        const conn = {
            query: async function (sql, params) {
                if (/GET_LOCK/i.test(sql))     return [{ l: 1 }];
                if (/RELEASE_LOCK/i.test(sql)) return [{}];
                if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) {
                    return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
                }
                // The ledger's own CREATE TABLE IF NOT EXISTS runs on every call; it is
                // setup, not a write the runner decided to make, so it is not recorded.
                if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return {};
                if (/^(UPDATE|INSERT|CREATE|ALTER|DROP)/i.test(sql.trim())) { updates.push({ sql, params }); return {}; }
                return [];
            },
            release: async function () {},
        };
        const db = {
            dbName: 'test_indexer',
            transactionConnection: null,
            getConnection: async () => conn,
            _ensureMigrationsLedger: Database.prototype._ensureMigrationsLedger,
            _runMigrationsInner: Database.prototype._runMigrationsInner,
            _assertPubkeyColumnIsUncompressedWide: Database.prototype._assertPubkeyColumnIsUncompressedWide,
            _migrationMode: Database.prototype._migrationMode,
            splitSqlStatements: Database.prototype.splitSqlStatements,
            stripSqlLineComments: Database.prototype.stripSqlLineComments,
            _destructiveAutoStatement: Database.prototype._destructiveAutoStatement,
            _isIdRepairUpdate: Database.prototype._isIdRepairUpdate,
        };
        const realLog = console.log, realErr = console.error, realWarn = console.warn;
        console.log = console.error = console.warn = (...a) => { logged.push(a.join(' ')); };
        try {
            await Database.prototype.runMigrations.call(db, {});
        } finally {
            console.log = realLog; console.error = realErr; console.warn = realWarn;
        }
        return { updates, logged };
    }

    it('a fully current ledger produces no heal and no divergence log', async function () {
        const { updates, logged } = await runAgainst(fileChecksums());
        assert.deepStrictEqual(updates, [], 'nothing should be written when every checksum matches');
        assert.ok(!logged.some(l => /content CHANGED/.test(l)), 'unexpected divergence: ' + logged.join(' | '));
    });

    it('the  pre-rename ledger heals silently instead of logging content CHANGED', async function () {
        // Exactly the prod-fleet shape: migrated before the 2026-07-12 rename, so the two
        // files that carry their own name in a comment recorded the pre-rename hashes.
        const ledger = fileChecksums();
        ledger.set('2026-06-03-unique-full-column-index-addresses.sql',
            '9fdbbcbda36b860a3214d5fcc3d057f3bdf413a99c9d5407e7ef9951a318fb1e');
        ledger.set('2026-06-09-cross-chain-matches-partial-fill-columns.sql',
            '289d9fe5fb41f8012e7cbcdb3d6c2e2a8c983ca84afd920d73b386a33d64e602');

        const { updates, logged } = await runAgainst(ledger);
        assert.ok(!logged.some(l => /content CHANGED/.test(l)),
            'the guard still cries wolf: ' + logged.filter(l => /content CHANGED/.test(l)).join(' | '));

        const healed = new Map(updates
            .filter(u => /SET checksum/i.test(u.sql))
            .map(u => [u.params[1], u.params[0]]));
        assert.strictEqual(healed.size, 2, 'both rows should be re-keyed, got: ' + JSON.stringify([...healed]));
        for (const [file, checksum] of healed) {
            assert.strictEqual(checksum, sha256(fs.readFileSync(path.join(MIG_DIR, file), 'utf8')),
                file + ': healed to something other than the current file checksum');
        }
    });

    it('a never-re-keyed ledger heals name AND checksum in one pass', async function () {
        // The untouched original shape: rows still under the legacy undated names, holding
        // the checksums of the content that was applied. Both heals must run in order (the
        // rename re-key first, then the rebaseline) or the file reads as never-applied and
        // a manual migration silently re-enters the pending list.
        const ledger = fileChecksums();
        const renames = Database.MIGRATION_LEDGER_RENAMES;
        ledger.delete(renames['unique_full_column_index_addresses.sql']);
        ledger.delete(renames['add_cross_chain_matches_partial_fill_columns.sql']);
        ledger.set('unique_full_column_index_addresses.sql',
            '9fdbbcbda36b860a3214d5fcc3d057f3bdf413a99c9d5407e7ef9951a318fb1e');
        ledger.set('add_cross_chain_matches_partial_fill_columns.sql',
            '289d9fe5fb41f8012e7cbcdb3d6c2e2a8c983ca84afd920d73b386a33d64e602');

        const { updates, logged } = await runAgainst(ledger);
        assert.ok(!logged.some(l => /content CHANGED/.test(l)), 'divergence still logged: ' + logged.join(' | '));
        assert.strictEqual(updates.filter(u => /SET name/i.test(u.sql)).length, 2, 'both rows should be re-keyed by name');
        assert.strictEqual(updates.filter(u => /SET checksum/i.test(u.sql)).length, 2, 'both rows should then be rebaselined');
        assert.deepStrictEqual(updates.filter(u => /^INSERT/i.test(u.sql.trim())), [],
            'a re-keyed row must not be re-applied as if it were pending');
    });

    it('an unpinned edit to a rebaselined file still trips the immutability guard', async function () {
        const ledger = fileChecksums();
        ledger.set('2026-06-03-unique-full-column-index-addresses.sql', 'f'.repeat(64));
        const { updates, logged } = await runAgainst(ledger);
        assert.deepStrictEqual(updates.filter(u => /SET checksum/i.test(u.sql)), [],
            'an unrecognized hash must never be healed away');
        assert.ok(logged.some(l => /content CHANGED/.test(l) && /unique-full-column-index-addresses/.test(l)),
            'a genuine migration edit must still be reported');
    });
});

// Backdating guard in the apply loop. Apply order is lexical, so a migration committed
// with a date EARLIER than one the fleet already applied runs in its date slot on a
// fresh DB and after the frontier on an aged one, diverging the schemas. Driven through
// the real _runMigrationsInner against the real migrations dir: seeding the ledger with
// every file EXCEPT an early auto one reproduces exactly the aged-DB shape.
describe('runMigrations() backdated-migration guard @regression @tier1', function () {

    const crypto  = require('crypto');
    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');

    const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const allFiles = () => fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
    const ledgerOfAll = () => new Map(allFiles().map(f => [f, sha256(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'))]));

    // Earliest committed mode=auto file: pulling it out of the ledger makes it pending
    // behind a frontier of everything else, which is the backdating shape.
    const EARLY_AUTO = allFiles().find(f =>
        modeOf(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')) === 'auto');
    const EARLY_MANUAL = allFiles().find(f =>
        modeOf(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')) === 'manual');

    async function runAgainst(ledger, opts) {
        const logged = [];
        const applied = [];
        const conn = {
            query: async function (sql, params) {
                if (/GET_LOCK/i.test(sql))     return [{ l: 1 }];
                if (/RELEASE_LOCK/i.test(sql)) return [{}];
                if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) {
                    return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
                }
                if (/^INSERT INTO schema_migrations/i.test(sql.trim())) { applied.push(params[0]); return {}; }
                if (/^(UPDATE|INSERT|CREATE|ALTER|DROP)/i.test(sql.trim())) return {};
                return [];
            },
            release: async function () {},
        };
        const db = {
            dbName: 'test_indexer',
            transactionConnection: null,
            getConnection: async () => conn,
            _ensureMigrationsLedger: async () => {},
            _runMigrationsInner: Database.prototype._runMigrationsInner,
            _migrationMode: Database.prototype._migrationMode,
            splitSqlStatements: Database.prototype.splitSqlStatements,
            stripSqlLineComments: Database.prototype.stripSqlLineComments,
            _destructiveAutoStatement: Database.prototype._destructiveAutoStatement,
            _isIdRepairUpdate: Database.prototype._isIdRepairUpdate,
        };
        const realLog = console.log, realErr = console.error, realWarn = console.warn;
        console.log = console.error = console.warn = (...a) => { logged.push(a.join(' ')); };
        try {
            const r = await Database.prototype._runMigrationsInner.call(db, opts || {});
            return { logged, applied, result: r, threw: null };
        } catch (err) {
            return { logged, applied, result: null, threw: err };
        } finally {
            console.log = realLog; console.error = realErr; console.warn = realWarn;
        }
    }

    it('the shipped tree is clean: a fully current ledger raises no backdating error', async function () {
        const { logged, threw } = await runAgainst(ledgerOfAll(), {});
        assert.strictEqual(threw, null, 'a current ledger must not throw: ' + (threw && threw.message));
        assert.ok(!logged.some(l => /dated BEFORE/.test(l)), 'unexpected backdating log: ' + logged.join(' | '));
    });

    it('the operator path fails closed on a backdated auto migration', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(EARLY_AUTO);
        const { threw } = await runAgainst(ledger, { includeManual: true });
        assert.ok(threw, 'the operator path must refuse a backdated migration, not apply it');
        assert.match(threw.message, /dated BEFORE already-applied migration/);
        assert.ok(threw.message.includes(EARLY_AUTO), 'the error must name the offending file');
    });

    it('opt-in strict mode fails closed on the passive startup path too', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(EARLY_AUTO);
        const prev = process.env.MIGRATION_STRICT_CHECKSUM;
        process.env.MIGRATION_STRICT_CHECKSUM = '1';
        try {
            const { threw } = await runAgainst(ledger, {});
            assert.ok(threw && /dated BEFORE already-applied migration/.test(threw.message));
        } finally {
            if (prev === undefined) delete process.env.MIGRATION_STRICT_CHECKSUM;
            else process.env.MIGRATION_STRICT_CHECKSUM = prev;
        }
    });

    it('default passive startup logs loudly but still boots (no fleet black-start)', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(EARLY_AUTO);
        const { logged, applied, threw } = await runAgainst(ledger, {});
        assert.strictEqual(threw, null, 'passive startup must not hard-fail the fleet');
        assert.ok(logged.some(l => /dated BEFORE already-applied migration/.test(l)),
            'the divergence must still be reported: ' + logged.join(' | '));
        assert.ok(applied.includes(EARLY_AUTO), 'behavior is unchanged on the passive path: the file still applies');
    });

    // The carve-out that keeps the guard shippable. A mode=manual file legitimately sits
    // unapplied behind the frontier for as long as the operator defers it, so guarding it
    // would make `node src/migrate.js` throw on every aged fleet DB.
    it('a deferred mode=manual migration is exempt and still applies on the operator path', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(EARLY_MANUAL);
        const { logged, applied, threw } = await runAgainst(ledger, { includeManual: true });
        assert.strictEqual(threw, null,
            'a deferred manual migration must not be mistaken for a backdated one: ' + (threw && threw.message));
        assert.ok(!logged.some(l => /dated BEFORE/.test(l)), 'manual files must not be flagged: ' + logged.join(' | '));
        assert.ok(applied.includes(EARLY_MANUAL), 'the operator must still be able to apply it');
    });

    // The aged-fleet shape the frontier filter exists for. A DB migrated between 7f1142e
    // and 1c728c5 carries an undated add_controller_bound_token_columns.sql row that no
    // rename heals, and undated sorts above every 2026-* name. Before the filter this made
    // the frontier garbage and threw on the operator path for an ordinary new migration -
    // the same hard-fail of `node src/migrate.js` on an aged fleet DB that the manual
    // carve-out above exists to prevent, reintroduced from the ledger side.
    it('an undated legacy ledger row does not fail the operator path for a normal new migration', async function () {
        const files  = allFiles();
        const newest = files[files.length - 1];          // at the frontier by construction
        const ledger = ledgerOfAll();
        ledger.delete(newest);
        ledger.set('add_controller_bound_token_columns.sql', 'legacy-checksum');
        const { logged, applied, threw } = await runAgainst(ledger, { includeManual: true });
        assert.strictEqual(threw, null,
            'an undated legacy row must not hard-fail an aged fleet DB: ' + (threw && threw.message));
        assert.ok(!logged.some(l => /dated BEFORE/.test(l)), 'unexpected backdating log: ' + logged.join(' | '));
        assert.ok(applied.includes(newest), 'the newest migration must still apply');
    });
});

// Per-file scoping (--file / opts.only), ported from the decoder's runner (#3874).
// A fleet rollout of ONE pending manual migration must not drag in the other ten:
// three of them are destructive (drop-legacy-escrows-column, drop-orphaned-contract-
// balances, markets-dedup-unique-pair). Driven against the REAL migrations dir - the
// indexer resolves it from __dirname, so there is no tmp-dir seam to substitute.
describe('runMigrations() --file / opts.only scoping @regression @tier1', function () {

    const TARGET = '2026-07-24-pubkeys-widen-uncompressed.sql';

    // Fake conn recording ledger INSERTs and executed migration-body statements.
    // `pubkeyLen` answers the post-run width assertion (#3875).
    function makeDb(ledgerRows, pubkeyLen = 130) {
        const applied  = [];
        const executed = [];
        const conn = {
            async query(sql, params) {
                if (/GET_LOCK/i.test(sql))                                         return [{ l: '1' }];
                if (/RELEASE_LOCK/i.test(sql))                                     return [];
                if (/CREATE TABLE (IF NOT EXISTS )?schema_migrations/i.test(sql))  return [];
                if (/SELECT name, checksum FROM schema_migrations/i.test(sql))     return ledgerRows.slice();
                if (/information_schema\.columns/i.test(sql))                      return [{ len: pubkeyLen }];
                if (/^INSERT INTO schema_migrations/i.test(sql.trim())) { applied.push(params[0]); return []; }
                if (/^UPDATE schema_migrations/i.test(sql.trim()))                 return [];
                executed.push(sql);
                return [];
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        db.dbName = 'fake_indexer';
        db.transactionConnection = null;
        db.getConnection = async () => conn;
        db._ensureMigrationsLedger = async () => {};
        return { db, applied, executed };
    }

    // The runner narrates every skip; keep the suite output readable.
    async function quietly(fn) {
        const realLog = console.log, realWarn = console.warn;
        console.log = console.warn = () => {};
        try { return await fn(); }
        finally { console.log = realLog; console.warn = realWarn; }
    }

    it('applies ONLY the targeted file and leaves every other one pending and untouched', async function () {
        const { db, applied, executed } = makeDb([]);
        const res = await quietly(() => db.runMigrations({ includeManual: true, only: TARGET }));
        assert.deepStrictEqual(applied, [TARGET], 'only the targeted file is recorded as applied');
        assert.deepStrictEqual(res.applied, [TARGET]);
        assert.ok(executed.some(s => /ALTER TABLE pubkeys\s+MODIFY pubkey VARCHAR\(130\)/i.test(s)),
            'the targeted DDL must run');
        assert.ok(!res.pending.includes(TARGET), 'the applied target is not also pending');
        assert.ok(res.pending.includes('2026-07-15-markets-dedup-unique-pair.sql'),
            'untargeted pending work is still reported to the operator');
        // The three destructive manual files are exactly what a blanket run would drag in.
        assert.ok(!executed.some(s => /DROP COLUMN|DROP TABLE|DELETE FROM/i.test(s)),
            'a scoped run must execute no untargeted destructive DDL: ' + executed.join(' | '));
    });

    it('accepts an array of targets', async function () {
        const { db, applied } = makeDb([]);
        const second = '2026-07-10-contract-state-bin-key-index.sql';
        const res = await quietly(() => db.runMigrations({ includeManual: true, only: [TARGET, second] }));
        assert.deepStrictEqual(applied.slice().sort(), [TARGET, second].sort());
        assert.ok(!res.pending.includes(TARGET) && !res.pending.includes(second));
    });

    it('is idempotent: re-targeting an already-applied file applies nothing', async function () {
        const dir = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');
        const sum = require('crypto').createHash('sha256')
            .update(fs.readFileSync(path.join(dir, TARGET), 'utf8')).digest('hex');
        const { db, applied, executed } = makeDb([{ name: TARGET, checksum: sum }]);
        const res = await quietly(() => db.runMigrations({ includeManual: true, only: TARGET }));
        assert.deepStrictEqual(applied, [], 'nothing re-applied (target already recorded)');
        assert.deepStrictEqual(res.applied, []);
        assert.deepStrictEqual(executed, [], 'no DDL at all on a no-op scoped run');
    });

    it('fails loudly on an unknown target (typo protection), applying nothing', async function () {
        const { db, applied } = makeDb([]);
        await assert.rejects(
            () => quietly(() => db.runMigrations({ includeManual: true, only: 'nope-not-a-file.sql' })),
            /target\(s\) not found/);
        assert.deepStrictEqual(applied, [], 'silently applying nothing would look like a successful no-op run');
    });

    it('throws when opts.only is an empty array (guards a mis-wired caller)', async function () {
        const { db } = makeDb([]);
        await assert.rejects(
            () => quietly(() => db.runMigrations({ includeManual: true, only: [] })), /empty/);
    });

    it('a blanket run (no opts.only) still walks the whole tree', async function () {
        const { db, applied } = makeDb([]);
        await quietly(() => db.runMigrations({ includeManual: true }));
        assert.ok(applied.length > 1 && applied.includes(TARGET),
            'the default path must remain apply-everything');
    });
});

// Post-run schema contract (#3875). 2026-07-24-pubkeys-widen-uncompressed.sql is
// mode=manual, so alterTableForDrift cannot heal it (that reconciler only ADDS
// columns and RELAXES nullability) and a scoped --file run can leave a fleet
// half-migrated with no operator signal. runMigrations asserts the width on every
// normal return so the half-migrated node halts instead of truncating pubkeys.
describe('runMigrations() pubkey-width assertion @regression @tier1', function () {

    function makeDb(pubkeyLen, { emptyDir = false } = {}) {
        const conn = {
            async query(sql) {
                if (/GET_LOCK/i.test(sql))                                        return [{ l: '1' }];
                if (/RELEASE_LOCK/i.test(sql))                                    return [];
                if (/SELECT name, checksum FROM schema_migrations/i.test(sql))    return [];
                if (/information_schema\.columns/i.test(sql))
                    return (pubkeyLen === null) ? [] : [{ len: pubkeyLen }];
                return [];
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        db.dbName = 'fake_indexer';
        db.transactionConnection = null;
        db.getConnection = async () => conn;
        db._ensureMigrationsLedger = async () => {};
        // A lock-skip returns early from the inner body; the wrapper must still assert.
        if (emptyDir) db._runMigrationsInner = async () => ({ applied: [], pending: [], lockSkipped: true });
        return db;
    }

    async function quietly(fn) {
        const realLog = console.log, realWarn = console.warn;
        console.log = console.warn = () => {};
        try { return await fn(); }
        finally { console.log = realLog; console.warn = realWarn; }
    }

    it('throws with the remedy when pubkeys.pubkey is too narrow for an uncompressed key', async function () {
        await assert.rejects(
            () => quietly(() => makeDb(66).runMigrations({ only: '2026-07-24-pubkeys-widen-uncompressed.sql' })),
            /pubkeys\.pubkey holds 66 chars but VARCHAR\(130\) is required[\s\S]*node src\/migrate\.js/);
    });

    it('passes at the migrated width', async function () {
        await quietly(() => makeDb(130).runMigrations({ only: '2026-07-24-pubkeys-widen-uncompressed.sql' }));
    });

    it('asserts even when the inner run examined nothing (lock skip)', async function () {
        await assert.rejects(
            () => quietly(() => makeDb(66, { emptyDir: true }).runMigrations({})),
            /VARCHAR\(130\) is required/);
    });

    it('stays silent when the column is absent (table not created yet)', async function () {
        await quietly(() => makeDb(null, { emptyDir: true }).runMigrations({}));
    });
});

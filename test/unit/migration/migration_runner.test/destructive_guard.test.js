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

const { assert, path, Database, modeOf, destructiveOf, statementsOf } = require('./helpers/migration_fixtures.js');


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
});

describe('Database._destructiveAutoStatement() @regression @tier1', function () {
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
});

describe('Database._destructiveAutoStatement() @regression @tier1', function () {
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
        // through and rewrote every row. They must now be flagged.
        // (a) trailing clause after WHERE id = 0
        assert.ok(destructiveOf(['UPDATE balances SET id = (SELECT 1) WHERE id = 0 OR 1=1']));
        // (b) a second, data-destroying SET assignment riding inside the id-repair shape
        assert.ok(destructiveOf(["UPDATE balances SET id = (SELECT id), amount = (SELECT '0') WHERE id = 0"]));
        // (c) a trailing LIMIT after the id=0 predicate
        assert.ok(destructiveOf(['UPDATE balances SET id = (SELECT 1) WHERE id = 0 LIMIT 1']));
    });
});

describe('Database._destructiveAutoStatement() @regression @tier1', function () {
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
});

describe('Database._destructiveAutoStatement() @regression @tier1', function () {
    it('a plain (non-executable) block comment still does not trigger', function () {
        assert.strictEqual(destructiveOf(['CREATE TABLE foo (id INT) /* DROP TABLE bar */']), null);
        assert.strictEqual(destructiveOf(['CREATE TABLE foo (id INT)']), null);
    });

    // ── `#` line comments: the server honours them, so the scanner must too ──

    it('the `#`-comment bypass is caught end to end from raw file text', function () {
        // Before the strip knew `#`, this chunk reached the classifier as
        // "# tidy legacy rows\nDROP TABLE balances", matched no ^-anchored check,
        // scored auto-eligible, and the server ran the DROP unattended at startup.
        const raw = '-- xchain:migration mode=auto\n# tidy legacy rows\nDROP TABLE balances;\n';
        assert.strictEqual(modeOf(raw), 'auto');
        const offender = destructiveOf(statementsOf(raw));
        assert.ok(offender && /DROP TABLE balances/i.test(offender),
            'a `#` comment line must not hide the DROP from the auto gate');
    });

    it('flags a statement still carrying a `#` line comment (strip-regression guard)', function () {
        // Fed directly, bypassing the strip: the classifier is the last line before
        // an unattended DROP, so a comment introducer it can still see fails closed.
        assert.ok(destructiveOf(['# tidy legacy rows\nDROP TABLE balances']));
        assert.ok(destructiveOf(['ALTER TABLE t ADD COLUMN y INT NULL # , DROP COLUMN x']));
    });

    it('does not flag a `#` inside a quoted literal or a block comment', function () {
        assert.strictEqual(destructiveOf(["INSERT INTO notes (body) VALUES ('#tag')"]), null);
        assert.strictEqual(destructiveOf(['ALTER TABLE `t#1` ADD COLUMN y INT NULL']), null);
        assert.strictEqual(destructiveOf(statementsOf(
            '-- xchain:migration mode=auto\n/* see issue #4373 */ ALTER TABLE t ADD COLUMN y INT NULL;'
        )), null);
    });

    // ── row-rewriting DML that starts with an unflagged keyword ──────────

    it('flags INSERT ... ON DUPLICATE KEY UPDATE (rewrites every colliding row)', function () {
        assert.ok(destructiveOf([
            "INSERT INTO tokens (ticker, description) VALUES ('XYZ','') ON DUPLICATE KEY UPDATE description=''"
        ]));
        assert.ok(destructiveOf([
            'INSERT INTO t (a, b) SELECT a, b FROM s\nON DUPLICATE KEY UPDATE b = VALUES(b)'
        ]));
    });

    it('does not flag a plain INSERT (additive: it only adds rows)', function () {
        assert.strictEqual(destructiveOf(["INSERT INTO tokens (ticker) VALUES ('XYZ')"]), null);
        assert.strictEqual(destructiveOf(['INSERT IGNORE INTO t (a) SELECT a FROM s']), null);
    });

    it('flags LOAD DATA (rows come from a file the classifier cannot read)', function () {
        assert.ok(destructiveOf(["LOAD DATA INFILE '/tmp/x.csv' REPLACE INTO TABLE balances"]));
        assert.ok(destructiveOf(["LOAD DATA LOCAL INFILE '/tmp/x.csv' INTO TABLE balances"]));
    });
});

describe('Database._destructiveAutoStatement() @regression @tier1', function () {
    // ── ALTER clauses that destroy rows with no DROP/RENAME/CHANGE/MODIFY ──

    it('flags ALTER TABLE partition clauses (TRUNCATE / EXCHANGE / ADD are one class)', function () {
        assert.ok(destructiveOf(['ALTER TABLE balances TRUNCATE PARTITION p0']));
        assert.ok(destructiveOf(['ALTER TABLE balances EXCHANGE PARTITION p0 WITH TABLE balances_old']));
        assert.ok(destructiveOf(['ALTER TABLE balances REORGANIZE PARTITION p0 INTO (PARTITION p1 VALUES LESS THAN (100))']));
        // Additive partition DDL is not separable from the destructive forms by prefix,
        // so it is non-auto-eligible too: tag the file mode=manual to run one.
        assert.ok(destructiveOf(['ALTER TABLE balances ADD PARTITION (PARTITION p2 VALUES LESS THAN (200))']));
        assert.ok(destructiveOf(['ALTER TABLE balances REMOVE PARTITIONING']));
    });

    it('flags ALTER TABLE tablespace clauses (DISCARD deletes the data file)', function () {
        assert.ok(destructiveOf(['ALTER TABLE balances DISCARD TABLESPACE']));
        assert.ok(destructiveOf(['ALTER TABLE balances IMPORT TABLESPACE']));
    });

    it('does not flag an ordinary column whose name merely contains "partition"', function () {
        assert.strictEqual(destructiveOf(['ALTER TABLE t ADD COLUMN partition_id INT NULL']), null);
    });
});

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

// Destructive-DDL guard helpers: same comment-strip + ';'-split runMigrations uses.
const stripComments = Database.prototype.stripSqlLineComments.bind({});
const destructiveOf = Database.prototype._destructiveAutoStatement.bind({});
const statementsOf  = (raw) => stripComments(raw).split(';').map(s => s.trim()).filter(Boolean);

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

    it('ignores a mode= tag outside the header window (body prose cannot arm auto)', function () {
        // A file whose real header omits the tag (defaults manual), with a spoofed
        // `mode=auto` buried 20+ lines down in prose or a data literal. The scan is
        // header-window-only, so this must stay manual - a body tag cannot arm the
        // auto-apply path for a destructive migration.
        let body = '-- a normal migration comment\n';
        for(let i = 0; i < 20; i++) body += '-- filler line ' + i + '\n';
        body += '-- xchain:migration mode=auto\nDROP TABLE contract_stakes;\n';
        assert.strictEqual(modeOf(body), 'manual');
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
        it(file + ': carries an explicit `-- xchain:migration mode=auto|manual` tag', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            const m = raw.match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
            assert.ok(m,
                file + ' has no explicit mode tag. Every migration must declare intent so a ' +
                'destructive change can never silently auto-run at startup. Add a first line: ' +
                '`-- xchain:migration mode=auto` (additive + idempotent) or `mode=manual` (gated).');
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

    it('every rebaseline pins two distinct 64-hex sha256 values', function () {
        for (const [file, r] of Object.entries(Database.MIGRATION_CHECKSUM_REBASELINES)) {
            assert.match(r.from, /^[0-9a-f]{64}$/, file + ': from must be a sha256 hex digest');
            assert.match(r.to,   /^[0-9a-f]{64}$/, file + ': to must be a sha256 hex digest');
            assert.notStrictEqual(r.from, r.to, file + ': from and to must differ');
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
});

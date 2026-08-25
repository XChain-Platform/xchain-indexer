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
 * A mode=auto migration must not widen an INDEXED column past the legacy key limit.
 *
 * runMigrations applies a `-- xchain:migration mode=auto` file unattended at startup and
 * rethrows a failed statement (src/db.js), so a statement that can fail on existing data
 * is a fleet-wide boot block with no operator in the loop. The runner's own contract says
 * as much: auto migrations must be additive and idempotent, and anything that can fail on
 * existing data must be mode=manual.
 *
 * The failure this guards is invisible to every check that already runs:
 *   - the destructive-DDL scanner (db._destructiveAutoStatement) deliberately ALLOWS a
 *     widening MODIFY without NOT NULL, so the mode tag is the only gate;
 *   - the schema-parity suites compare the two schema paths to each other, and both
 *     paths carry the same widened column, so they agree and stay green;
 *   - nothing in the tree reads information_schema row_format, so no code detects the
 *     precondition before the ALTER runs.
 *
 * The mechanism: at utf8mb4 a VARCHAR(250) index key is 250 * 4 = 1000 bytes. That fits
 * the 3072-byte InnoDB limit only under ROW_FORMAT=DYNAMIC (the MariaDB 10.2+ default);
 * on a table still in COMPACT or REDUNDANT the limit is 767 bytes and the ALTER fails
 * with errno 1071 rather than applying. At utf8mb3 the same key is 750 bytes, under the
 * legacy limit, so the index is created happily and the WIDEN is what trips.
 * 2026-08-19-utf8mb4-index-memos-memo.sql is the house's correct handling of exactly this
 * hazard: split to mode=manual with a documented row-format pre-check.
 *
 * This guard is FORWARD-ONLY by ruling. Migrations are immutable once applied
 * (runMigrations sha256s each file against the schema_migrations ledger), so the one
 * already-shipped instance is recorded as a dated exemption below rather than edited.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');

// The legacy (COMPACT / REDUNDANT) InnoDB index-key-prefix limit, in bytes. DYNAMIC and
// COMPRESSED raise it to 3072; a table with no ROW_FORMAT clause takes
// innodb_default_row_format, which the house cannot inspect on a third-party operator's
// database. utf8mb4 is 4 bytes per character at worst, which is what the engine budgets.
const LEGACY_KEY_LIMIT_BYTES = 767;
const UTF8MB4_BYTES_PER_CHAR = 4;

// The real runner's own parsers, not re-implementations: mode detection and statement
// splitting must not be able to drift from what actually decides an unattended apply.
const migrationMode = (raw) => Database.prototype._migrationMode.call(null, raw);
const splitStatements = (raw) => Database.prototype.splitSqlStatements.call(
    { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);

/**
 * ONE dated exemption, for the single instance that had already shipped and applied when
 * this guard was written. It is recorded here rather than fixed in place because editing
 * an applied migration changes its sha256 and fails `node src/migrate.js` closed forever
 * on every database that already applied it, and because a backdated replacement file
 * trips the runner's dated-frontier guard on the same operator path.
 *
 * Measured basis for accepting the residual exposure, taken on the test venue during the
 * review round that recorded this exemption (#5807, 2026-08-25): at MariaDB 10.11.14 with
 * innodb_default_row_format=dynamic the indexer schema carries ZERO non-Dynamic InnoDB
 * tables, so the boot block is not live on anything built by MariaDB >= 10.2. What is left
 * is a third-party operator running the AGPL indexer against a database whose `files` table
 * is still on a legacy row format; that operator's remedy is
 * `ALTER TABLE files ROW_FORMAT=DYNAMIC;` before the migration runs.
 *
 * An entry here is not a permanent pass: `exemptions` below is asserted to be exactly the
 * set of violations present in the tree, so a stale entry fails this suite as loudly as
 * an unguarded new one.
 */
const EXEMPTIONS = [
    {
        file:   '2026-08-19-utf8mb4-user-text-columns.sql',
        table:  'files',
        column: 'name',
        bytes:  1000,
    },
];

const exemptionKey = (v) => v.file + ':' + v.table + '.' + v.column + ':' + v.bytes;
const EXEMPT_KEYS  = new Set(EXEMPTIONS.map(exemptionKey));

/**
 * table -> { column: prefixLengthOrNull } for every column any src/sql/<table>.sql
 * declares an index on, in either legitimate declaration form: a standalone
 * `CREATE [UNIQUE] INDEX ... ON <table> (...)` or an inline `KEY` / `UNIQUE KEY` /
 * `PRIMARY KEY` clause inside the CREATE TABLE block. Definition coverage is complete by
 * construction: sql-schema-index-parity.test.js already forbids an index that exists only
 * on the migration ledger.
 *
 * A `(len)` prefix is kept, because a prefixed index budgets only the prefix.
 * The widest declaration wins when a column is indexed twice (a bare column beats a
 * prefixed one), so the check always measures the largest key the engine is asked for.
 */
function declaredIndexColumns(){
    const out = {};
    const add = (table, columnList) => {
        const t = String(table).toLowerCase();
        const m = (out[t] || (out[t] = {}));
        for(const part of String(columnList).split(',')){
            const parsed = /^\s*`?(\w+)`?\s*(?:\(\s*(\d+)\s*\))?/.exec(part);
            if(!parsed) continue;
            const column = parsed[1].toLowerCase();
            const prefix = parsed[2] ? Number(parsed[2]) : null;
            // null (whole column) is the widest key; never let a prefixed
            // declaration narrow an unprefixed one already recorded.
            if(!(column in m) || prefix === null) m[column] = prefix;
        }
    };

    for(const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'))){
        const raw = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');

        for(const m of raw.matchAll(
            /CREATE\s+(?:UNIQUE\s+)?INDEX\s+`?\w+`?\s+ON\s+`?(\w+)`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi))
            add(m[1], m[2]);

        const createTable = raw.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
        if(!createTable) continue;
        for(const m of raw.matchAll(/^\s*(?:UNIQUE\s+)?KEY\s+`?\w+`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gim))
            add(createTable[1], m[1]);
        for(const m of raw.matchAll(/^\s*PRIMARY\s+KEY\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gim))
            add(createTable[1], m[1]);
    }
    return out;
}

/**
 * Scan ONE migration's raw text for oversized utf8mb4 index keys.
 * Returns [] for anything that does not auto-apply, so a mode=manual file (which an
 * operator runs with the row-format pre-check in hand) is deliberately out of scope.
 *
 * Two statement shapes set utf8mb4 on a column:
 *   MODIFY <col> VARCHAR(n) ... CHARACTER SET utf8mb4   - per column, n from the clause
 *   ALTER TABLE <t> CONVERT TO CHARACTER SET utf8mb4    - every column of the table,
 *                                                         widths from the definition file
 * The second form carries no column list at all, which is exactly why it is scanned:
 * it would otherwise be the way around this guard.
 */
function scanMigration(name, raw, indexedByTable, definitionWidths){
    if(migrationMode(raw) !== 'auto') return [];
    const violations = [];
    const record = (table, column, chars) => {
        const indexed = indexedByTable[table];
        if(!indexed || !(column in indexed)) return;
        const prefix = indexed[column];
        const keyChars = (prefix === null) ? chars : Math.min(prefix, chars);
        const bytes = keyChars * UTF8MB4_BYTES_PER_CHAR;
        if(bytes > LEGACY_KEY_LIMIT_BYTES) violations.push({ file: name, table, column, bytes });
    };

    for(const stmt of splitStatements(raw)){
        const t = /^\s*ALTER\s+TABLE\s+`?(\w+)`?/i.exec(stmt);
        if(!t) continue;
        const table = t[1].toLowerCase();

        if(/\bCONVERT\s+TO\s+CHARACTER\s+SET\s+utf8mb4\b/i.test(stmt)){
            const widths = definitionWidths[table] || {};
            for(const column of Object.keys(widths)) record(table, column, widths[column]);
        }

        for(const m of stmt.matchAll(
            /\bMODIFY\s+(?:COLUMN\s+)?`?(\w+)`?([\s\S]*?)(?=,\s*MODIFY\s|,\s*ADD\s|,\s*DROP\s|,\s*CHANGE\s|$)/gi)){
            const spec = m[2];
            if(!/CHARACTER\s+SET\s+utf8mb4\b/i.test(spec)) continue;
            const varchar = /\bVARCHAR\s*\(\s*(\d+)\s*\)/i.exec(spec);
            if(!varchar) continue;   // TEXT/MEDIUMTEXT are only indexable with an explicit prefix
            record(table, m[1].toLowerCase(), Number(varchar[1]));
        }
    }
    return violations;
}

// table -> { column: varcharLength } from the canonical definitions, for the CONVERT TO
// arm (which names no columns and no widths of its own).
function definitionVarcharWidths(){
    const out = {};
    for(const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'))){
        const raw = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
        const createTable = raw.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
        if(!createTable) continue;
        const table = createTable[1].toLowerCase();
        const widths = (out[table] || (out[table] = {}));
        const parsed = Database.prototype.parseExpectedColumns.call(
            { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
        for(const column of (parsed || [])){
            const varchar = /\bVARCHAR\s*\(\s*(\d+)\s*\)/i.exec(String(column.definition || ''));
            if(varchar) widths[column.name.toLowerCase()] = Number(varchar[1]);
        }
    }
    return out;
}

function scanTree(){
    const indexed = declaredIndexColumns();
    const widths  = definitionVarcharWidths();
    const found   = [];
    for(const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()){
        const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
        found.push(...scanMigration(file, raw, indexed, widths));
    }
    return found;
}

const AUTO_HEADER   = '-- xchain:migration mode=auto\n-- synthetic fixture\n\n';
const MANUAL_HEADER = '-- xchain:migration mode=manual\n-- synthetic fixture\n\n';
const WIDEN_INDEXED = 'ALTER TABLE files\n  MODIFY name VARCHAR(250) CHARACTER SET utf8mb4 ' +
                      'COLLATE utf8mb4_general_ci;\n';

describe('mode=auto migrations never widen an indexed column past the legacy key limit @regression', function () {

    // The scanner's inputs, resolved once from the real tree so the control cases below
    // exercise the same collectors the tree scan uses.
    const indexed = declaredIndexColumns();
    const widths  = definitionVarcharWidths();
    const scan    = (name, raw) => scanMigration(name, raw, indexed, widths);

    // NEGATIVE CONTROLS. A guard that lands green on day one proves nothing until it has
    // been shown to go red, so each arm the tree scan depends on is driven to a hit and
    // then to a miss against synthetic input.

    it('control: the collectors see files.name as an indexed VARCHAR(250)', function () {
        assert.ok(indexed.files, 'src/sql/files.sql declares no indexes at all - the collector broke');
        assert.ok('name' in indexed.files,
            'files.name is no longer collected as indexed, so the tree scan below cannot fail on it');
        assert.strictEqual(indexed.files.name, null, 'files.name is indexed whole, with no (len) prefix');
        assert.strictEqual(widths.files.name, 250);
    });

    it('control: a mode=auto widen of an indexed 250-char column is FLAGGED at 1000 bytes', function () {
        const hits = scan('2099-01-01-synthetic-control.sql', AUTO_HEADER + WIDEN_INDEXED);
        assert.deepStrictEqual(hits, [{
            file: '2099-01-01-synthetic-control.sql', table: 'files', column: 'name', bytes: 1000,
        }]);
    });

    it('control: the same widen tagged mode=manual is NOT flagged', function () {
        assert.deepStrictEqual(scan('2099-01-01-synthetic-manual.sql', MANUAL_HEADER + WIDEN_INDEXED), []);
    });

    it('control: widening an UNINDEXED column of the same width and charset is NOT flagged', function () {
        assert.ok(!('title' in indexed.files), 'files.title gained an index - this control no longer isolates');
        const raw = AUTO_HEADER +
            'ALTER TABLE files\n  MODIFY title VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;\n';
        assert.deepStrictEqual(scan('2099-01-01-synthetic-unindexed.sql', raw), []);
    });

    it('control: a narrow indexed column (VARCHAR(100) = 400 bytes) is NOT flagged', function () {
        const raw = AUTO_HEADER +
            'ALTER TABLE files\n  MODIFY name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;\n';
        assert.deepStrictEqual(scan('2099-01-01-synthetic-narrow.sql', raw), []);
    });

    it('control: a table-level CONVERT TO utf8mb4 is FLAGGED even though it names no column', function () {
        const raw = AUTO_HEADER + 'ALTER TABLE files CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;\n';
        assert.deepStrictEqual(scan('2099-01-01-synthetic-convert.sql', raw),
            [{ file: '2099-01-01-synthetic-convert.sql', table: 'files', column: 'name', bytes: 1000 }]);
    });

    // THE GUARD.

    it('no unexempted mode=auto migration widens an indexed column past 767 bytes', function () {
        const offenders = scanTree().filter(v => !EXEMPT_KEYS.has(exemptionKey(v)));
        assert.deepStrictEqual(offenders, [],
            'These mode=auto migrations widen an INDEXED column to a utf8mb4 key over the legacy ' +
            '767-byte InnoDB limit. On a table still in ROW_FORMAT=COMPACT or REDUNDANT the ALTER ' +
            'fails errno 1071, runMigrations rethrows, and the indexer cannot boot - unattended, ' +
            'fleet-wide, with no operator in the loop. Ship the column as a dated mode=manual file ' +
            'carrying the row-format pre-check, the way 2026-08-19-utf8mb4-index-memos-memo.sql ' +
            'does:\n  ' + offenders.map(v =>
                v.file + ': ' + v.table + '.' + v.column + ' = ' + v.bytes + ' bytes').join('\n  '));
    });

    // An exemption is a record of an already-applied file, so it must stay pinned to a
    // violation that is really still there. Without this arm a stale entry would sit in
    // the list forever and quietly widen the guard's blind spot.
    it('every recorded exemption still corresponds to a live violation', function () {
        const live  = new Set(scanTree().map(exemptionKey));
        const stale = EXEMPTIONS.map(exemptionKey).filter(k => !live.has(k));
        assert.deepStrictEqual(stale, [],
            'These exemptions no longer match anything in the tree; delete them rather than ' +
            'leaving the guard exempting a file that has changed:\n  ' + stale.join('\n  '));
    });

    it('the exemption list is the one already-applied instance, and stays that way', function () {
        assert.strictEqual(EXEMPTIONS.length, 1,
            'A second exemption means a new oversized widen shipped mode=auto. That is the defect ' +
            'this guard exists to stop, not a list to grow.');
    });
});

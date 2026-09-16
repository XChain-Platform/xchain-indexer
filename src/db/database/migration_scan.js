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
 *
 * XChain Indexer - Database class part: migration scan
 *
 * Reads of a migration file and its ledger: the mode tag, the destructive-DDL scan for the
 * auto path, the id-repair carve-out, the ledger table and the precondition lookup.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { opensBackslashEscape } = require('../shared.js');
// The class itself, for the statics these methods read. db/index.js publishes it before it
// requires any part, so this resolves to the finished class rather than a half-built export.
const Database = require('../index.js');

    // Drops that remove metadata only; anything else after DROP inside an
    // ALTER (COLUMN, PARTITION, or a bare column identifier) loses data.
    const SAFE_ALTER_DROP = new Set(['INDEX', 'KEY', 'FOREIGN', 'CONSTRAINT', 'CHECK', 'DEFAULT', 'PRIMARY']);
    // True when a `#` sits outside every quoted span - a line comment
    // stripSqlLineComments should already have removed. Quote-aware so a `#`
    // inside a string literal or a backtick identifier is not mistaken for one.
    // Local rather than a method: runMigrations' callers build partial `this`
    // objects, and a second prototype hop would break the guard on those.
    const hasUnquotedHash = (s) => {
        let q = null;
        for(let i = 0; i < s.length; i++){
            const c = s[i];
            if(q){
                if(opensBackslashEscape(s, i, q)){ i++; continue; }
                if(c === q){
                    if(s[i + 1] === q){ i++; }
                    else { q = null; }
                }
                continue;
            }
            if(c === "'" || c === '"' || c === '`'){ q = c; continue; }
            if(c === '#') return true;
        }
        return false;
    };

// destructiveAutoStatement, the statement-prefix keyword checks: true when the statement
// itself can lose, rewrite or smuggle data past the classifier.
function keywordDestroys(self, stmt){
    // Server-side indirection escapes a statement-prefix classifier: a mode=auto
    // file can smuggle destructive SQL past every keyword check below via dynamic
    // SQL (`SET @s = 'DROP TABLE balances'; PREPARE stmt FROM @s; EXECUTE stmt;`)
    // or a `CALL proc()` whose body the scanner cannot see. None of these are used
    // by any committed auto migration, so treat them as non-auto-eligible. SET of a
    // user variable (`SET @s = ...`) exists to stage dynamic SQL for PREPARE, so
    // flag it too - but NOT system-variable SETs (`SET NAMES ...`, `SET sql_mode
    // = ...`, `SET @@session...`), which are benign and stay auto-eligible.
    if(/^PREPARE\b/i.test(stmt))                         return true;
    if(/^EXECUTE\b/i.test(stmt))                         return true;
    if(/^CALL\b/i.test(stmt))                            return true;
    if(/^SET\s+@(?!@)/i.test(stmt))                      return true;
    if(/^DROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(stmt))  return true;
    // CREATE OR REPLACE TABLE is an atomic DROP TABLE IF EXISTS + CREATE: it destroys
    // every existing row. Plain CREATE TABLE / CREATE TABLE IF NOT EXISTS are additive
    // and stay unflagged (see the CREATE note below); only the OR REPLACE form loses
    // data. DROP TABLE is already flagged, so an author must not be able to slip the
    // data-losing idempotent-create variant past the auto guard.
    if(/^CREATE\s+OR\s+REPLACE\s+(TEMPORARY\s+)?TABLE\b/i.test(stmt)) return true;
    if(/^TRUNCATE\b/i.test(stmt))                        return true;
    if(/^RENAME\s+TABLE\b/i.test(stmt))                  return true;
    // Any DELETE removes row data - there is no non-destructive form - so match the
    // bare keyword, not `DELETE FROM`. The narrower form let valid-but-non-canonical
    // syntax slip the auto guard: `DELETE LOW_PRIORITY FROM`, `DELETE IGNORE FROM`,
    // and multi-table `DELETE t1 FROM t1 JOIN t2 ...` all delete rows yet omit an
    // immediate FROM. No false positive: a statement starting with DELETE is always DML.
    if(/^DELETE\b/i.test(stmt))                          return true;
    // REPLACE INTO is an atomic DELETE+INSERT on every existing-key row it
    // touches - the same data-loss profile as DELETE, with no non-destructive
    // form - so match the bare keyword like DELETE above.
    if(/^REPLACE\b/i.test(stmt))                         return true;
    // INSERT ... ON DUPLICATE KEY UPDATE overwrites columns of every existing
    // duplicate-key row it touches - the same data-rewrite profile the UPDATE arm
    // below hard-blocks, reached from a keyword that arm never sees. Plain INSERT
    // stays auto-eligible: with no ON DUPLICATE clause it only adds rows.
    if(/^INSERT\b[\s\S]*\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.test(stmt)) return true;
    // LOAD DATA ... REPLACE INTO TABLE is a DELETE+INSERT on every key collision,
    // and the rows come from a file the classifier cannot read, so no form of it
    // can be judged safe from the statement text. No committed auto migration
    // loads a file; treat the whole form as non-auto-eligible.
    if(/^LOAD\s+DATA\b/i.test(stmt))                     return true;
    // A bare UPDATE can rewrite arbitrary row data. The one committed auto
    // pattern is the AUTO_INCREMENT id repair (`UPDATE <table> SET id = (...)
    // WHERE id = 0;` in 2026-06-10-mirror-id-autoincrement-repair.sql), which
    // touches only the sentinel id=0 row; carve exactly that shape out and
    // flag every other UPDATE.
    if(/^UPDATE\b/i.test(stmt) && !self.isIdRepairUpdate(stmt)) return true;
    return false;
}

// destructiveAutoStatement, the ALTER TABLE clause checks: true when any clause can lose or
// rename data.
function alterTableDestroys(stmt){
    // Partition and tablespace clauses move or discard row data while carrying
    // none of the keywords the checks below look for: TRUNCATE PARTITION empties
    // a partition, EXCHANGE PARTITION swaps its rows out to another table,
    // DISCARD TABLESPACE deletes the table's data file. The additive members of
    // the class (ADD PARTITION, IMPORT TABLESPACE) are not separable from the
    // destructive ones by prefix, and no committed migration partitions anything,
    // so the whole class is non-auto-eligible - re-tag mode=manual to run one.
    if(/\bPARTITION(?:ING)?\b/i.test(stmt))          return true;
    if(/\bTABLESPACE\b/i.test(stmt))                 return true;
    // Every DROP inside the ALTER must target a safe (metadata-only) object.
    let m;
    const dropRe = /\bDROP\s+([A-Za-z_]+|`[^`]+`)/gi;
    while((m = dropRe.exec(stmt)) !== null){
        const target = m[1].replace(/`/g, '').toUpperCase();
        if(!SAFE_ALTER_DROP.has(target)) return true;
    }
    // RENAME TO / RENAME COLUMN / bare RENAME lose the old name; only
    // RENAME INDEX/KEY is a metadata-only rename.
    if(/\bRENAME\b(?!\s+(INDEX|KEY)\b)/i.test(stmt)) return true;
    // CHANGE [COLUMN] renames and retypes in one clause - manual only.
    if(/\bCHANGE\b/i.test(stmt))                     return true;
    // MODIFY that adds NOT NULL narrows the column domain - except an
    // AUTO_INCREMENT attribute repair: an AUTO_INCREMENT column is
    // definitionally NOT NULL, so no domain is narrowed (see the
    // committed 2026-06-10-mirror-id-autoincrement-repair.sql pattern).
    // Check per top-level clause: a statement-wide AUTO_INCREMENT test
    // would let one AUTO_INCREMENT clause exempt a sibling NOT NULL clause
    // in the same multi-clause ALTER (e.g. `MODIFY id ... AUTO_INCREMENT,
    // MODIFY source VARCHAR(255) NOT NULL`).
    let mDepth = 0, mStart = 0;
    const mClauses = [];
    for(let i=0;i<stmt.length;i++){
        const ch = stmt[i];
        if(ch === '(') mDepth++;
        else if(ch === ')') mDepth--;
        else if(ch === ',' && mDepth === 0){ mClauses.push(stmt.slice(mStart, i)); mStart = i + 1; }
    }
    mClauses.push(stmt.slice(mStart));
    for(const clause of mClauses){
        if(/\bMODIFY\b[\s\S]*\bNOT\s+NULL\b/i.test(clause) &&
           !/\bAUTO_INCREMENT\b/i.test(clause))      return true;
    }
    return false;
}

module.exports = {

    // Read a migration file's `-- xchain:migration mode=auto|manual` header tag.
    // Defaults to 'manual' when absent (conservative - unknown DDL never auto-runs).
    migrationMode(raw){
        // The mode tag is a leading-prologue directive: it may only sit in the run of
        // blank and `--`-comment lines BEFORE the first SQL statement. Scanning the
        // whole file (the old /m behavior) let a `mode=auto` token buried in body prose
        // or a data literal silently arm auto-apply for a destructive migration. A fixed
        // first-N-lines window (the old slice(0,10)) fixed that but was too tight: the
        // standard multi-line license banner pushes the tag past line 10, so every
        // banner-prefixed `mode=auto` migration was silently read as the `manual`
        // default and never auto-applied. Anchoring to the comment prologue keeps the
        // body-buried protection (the scan stops at the first non-comment, non-blank
        // line, so no data literal or trailing prose can be seen) while accommodating
        // any length of leading comment banner. Kept byte-for-byte in step with the
        // sibling runner at xchain-decoder/src/db.js:migrationMode.
        const lines    = String(raw).split('\n');
        const prologue = [];
        for(const line of lines){
            const trimmed = line.trim();
            if(trimmed === '' || trimmed.startsWith('--')){ prologue.push(line); continue; }
            break;   // first non-blank, non-comment line ends the prologue
        }
        const m = prologue.join('\n').match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
        return m ? m[1].toLowerCase() : 'manual';
    },

    // Destructive-DDL scan for the auto-apply path. Given a migration file's
    // statement list (already line-comment-stripped and ';'-split), returns the
    // first statement that can lose, truncate, or rename data - or null when the
    // file is safe to auto-run. Pure string logic (no DB), unit-tested directly.
    //
    // Flagged as destructive: DROP TABLE/DATABASE/SCHEMA, TRUNCATE, RENAME TABLE,
    // DELETE (any form), REPLACE INTO (atomic DELETE+INSERT), INSERT ... ON DUPLICATE
    // KEY UPDATE (rewrites every colliding row), LOAD DATA (rows from a file the
    // scanner cannot read), UPDATE (except the
    // committed AUTO_INCREMENT id=0 repair), ALTER TABLE ... DROP <column|partition|bare identifier>,
    // ALTER TABLE ... RENAME (except RENAME INDEX/KEY), ALTER TABLE ... CHANGE
    // (rename+retype), MODIFY ... NOT NULL (the statically detectable
    // narrowing; a width reduction cannot be seen without the live schema and
    // stays covered by the manual-tag convention), and any ALTER TABLE PARTITION or
    // TABLESPACE clause.
    //
    // Deliberately NOT flagged (legitimate existing auto patterns): DROP INDEX/KEY,
    // DROP FOREIGN KEY/CONSTRAINT/CHECK/DEFAULT/PRIMARY KEY (structural, no row
    // data lost), ADD ..., plain CREATE TABLE / CREATE TABLE IF NOT EXISTS (additive;
    // but CREATE OR REPLACE TABLE IS flagged - it is an atomic DROP+CREATE), and
    // MODIFY that widens/nullables a column.
    destructiveAutoStatement(statements){
        for(const raw of (statements || [])){
            // Executable (versioned) comments are the one /* */ form the server RUNS:
            // MariaDB/MySQL execute `/*!50000 DROP TABLE balances */` and `/*M! ... */`
            // verbatim, and splitSqlStatements strips only `--` lines, so the payload
            // reaches conn.query intact. The block-comment strip below would delete it
            // before any keyword check, scoring the file safe and auto-running the DROP.
            // Same class as the PREPARE/EXECUTE/CALL forms below - the server does
            // something a prefix classifier cannot see - and no committed auto migration
            // uses one, so treat any statement carrying one as non-auto-eligible.
            if(/\/\*(?:!|M!)/i.test(String(raw)))                return raw;
            // Belt-and-braces: strip /* */ block comments (line comments are already
            // gone) so a keyword inside comment prose never triggers or hides a hit.
            const stmt = String(raw).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
            if(!stmt) continue;
            // Second layer behind stripSqlLineComments: MariaDB/MySQL honour `#` to
            // end-of-line as a comment, so `# note\nDROP TABLE balances` is a DROP every
            // ^-anchored check below is blind to. The strip removes it upstream; if one
            // ever reaches here the strip has regressed, and the only safe reading of a
            // comment introducer the classifier can still see is non-auto-eligible.
            if(hasUnquotedHash(stmt))                            return raw;
            if(keywordDestroys(this, stmt))                      return raw;
            if(/^ALTER\s+TABLE\b/i.test(stmt) && alterTableDestroys(stmt)) return raw;
        }
        return null;
    },

    // True only for the one committed auto UPDATE shape: the AUTO_INCREMENT id
    // repair `UPDATE <table> SET id = (<subquery>) WHERE id = 0`. The old carve-out
    // regex was unanchored (`0\b`, no `$`) and used a greedy paren-unaware
    // `\([\s\S]+\)`, so `... WHERE id = 0 OR 1=1` and a smuggled second assignment
    // `SET id = (...), amount = (...)` both slipped past the guard and rewrote every
    // row. This matches the shape structurally instead: (1) a single table then
    // `SET id = (`; (2) a balanced-paren, quote-aware walk finds the value's true
    // matching `)`, so no extra assignment or clause can ride inside the wildcard;
    // (3) the remainder must be exactly `WHERE id = 0`, end-anchored, so nothing
    // trails. The 2026-06-10-mirror-id-autoincrement-repair.sql migration uses a
    // NESTED subquery with commas, so a "no inner parens / no commas" rule would
    // wrongly reject it and hard-fail startup; the balanced scan is required.
    isIdRepairUpdate(stmt){
        const head = /^UPDATE\s+(?:`[^`]+`|[A-Za-z0-9_$.]+)\s+SET\s+id\s*=\s*\(/i.exec(stmt);
        if(!head) return false;
        let i = head[0].length - 1;              // index of the opening '('
        let depth = 0;
        let quote = null;
        for(; i < stmt.length; i++){
            const ch = stmt[i];
            if(quote){
                if(opensBackslashEscape(stmt, i, quote)){ i++; continue; }
                if(ch === quote){
                    if(stmt[i + 1] === quote){ i++; }    // doubled-quote escape
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; continue; }
            if(ch === '('){ depth++; }
            else if(ch === ')'){ depth--; if(depth === 0){ i++; break; } }
        }
        if(depth !== 0) return false;            // unbalanced parens: not the repair shape
        return /^\s*WHERE\s+id\s*=\s*0\s*;?\s*$/i.test(stmt.slice(i));
    },

    // Create the migration ledger if absent. Created directly (not via src/sql/) - it
    // is infrastructure, not a domain table, so verifyTables() doesn't manage it.
    async ensureMigrationsLedger(conn){
        await conn.query(
            'CREATE TABLE IF NOT EXISTS schema_migrations (' +
            "name VARCHAR(255) NOT NULL PRIMARY KEY, " +
            "checksum VARCHAR(64) NOT NULL, " +
            "mode VARCHAR(10) NOT NULL DEFAULT 'manual', " +
            'applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP' +
            ') ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci'
        );
    },

    // Evaluate a migration's declared precondition against the live schema. Returns a
    // human reason string when the migration does NOT apply to this database (the caller
    // baselines it), or null when it should run. Files with no entry always run.
    // Runs on the caller's migration connection so it stays inside the migration lock.
    async migrationPreconditionSkip(file, conn){
        const pre = Database.MIGRATION_PRECONDITIONS[file];
        if(!pre) return null;
        const rows = await conn.query(pre.sql, [this.dbName]);
        return pre.skipWhen(rows || []);
    },

};

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
 * The two column-construction paths, read out of the tree for the column parity
 * suite (../../sql_schema_column_parity.test.js and the parts beside it): the
 * columns and CREATE TABLE bodies each src/sql/<table>.sql definition declares,
 * and what the dated migrations under src/sql/migrations/ add, create and retype.
 ********************************************************************/

const fs     = require('fs');
const path   = require('path');

const Database = require('../../../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');

const stripComments = (sql) => Database.prototype.stripSqlLineComments.call({}, sql);

// A column spec normalized for comparison across the two paths: uppercased, single
// spaces, no backticks/trailing commas, and with any positional clause removed (the
// position is asserted separately). `VARCHAR(256) NOT NULL DEFAULT '0'` compares equal
// no matter how the source file wrapped or aligned it.
function normalizeSpec(spec) {
    return String(spec || '')
        .replace(/`/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*$/, '')
        .replace(/\s+(AFTER\s+\w+|FIRST)\s*$/i, '')
        .trim()
        .toUpperCase();
}

// table -> ordered [{ name, spec }] from the canonical definitions. Uses the SAME
// parser the startup drift reconciler uses (parseExpectedColumns), so a parse gap
// here is a parse gap there.
function collectDefinitionColumns() {
    const out = {};
    for (const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'))) {
        const raw     = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
        const table   = file.slice(0, -4);
        const columns = Database.prototype.parseExpectedColumns.call(
            { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
        if (!columns) continue;
        out[table] = columns.map(c => ({ name: c.name, spec: normalizeSpec(c.definition.replace(new RegExp('^\\s*`?' + c.name + '`?\\s*', 'i'), '')) }));
    }
    return out;
}

// Every column a dated migration adds: { file, table, name, spec, after, first }.
function collectMigrationColumns() {
    const out = [];
    for (const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))) {
        const raw = stripComments(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
        // One file can ALTER several tables, so bind each ADD COLUMN to the table of
        // the statement it sits in (statements are `;`-terminated).
        for (const stmt of raw.split(';')) {
            const t = stmt.match(/ALTER\s+TABLE\s+`?(\w+)`?/i);
            if (!t) continue;
            for (const m of stmt.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?([\s\S]*?)(?=,\s*ADD\s|,\s*DROP\s|$)/gi)) {
                const body  = m[2] || '';
                const after = body.match(/\bAFTER\s+`?(\w+)`?/i);
                out.push({
                    file, table: t[1], name: m[1],
                    spec:  normalizeSpec(body),
                    after: after ? after[1] : null,
                    first: /\bFIRST\b\s*,?\s*$/i.test(body.trim()),
                });
            }
        }
    }
    return out;
}

// Tables a dated migration CREATEs outright: { file, table, columns:[{name,spec}], tail }.
// A migration can add a whole TABLE, not just a column, and such a table is ledger-covered
// exactly like a migration-added column: a replica converged by replaying migrations alone
// DOES gain it. Without this parse the guard below saw its columns as definition-only
// orphans, and the only way to quiet it was to park the table in the PRE-LEDGER baseline -
// a false provenance claim that then hid every later drift on that table.
// Uses the SAME parser as the definitions (parseExpectedColumns handles the migration's
// `IF NOT EXISTS`), so the two sides are compared through one code path.
function collectMigrationCreatedTables() {
    const out = [];
    for (const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
        const raw = stripComments(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
        for (const m of raw.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\([\s\S]+?\)\s*(ENGINE[^;]*)/gi)) {
            const columns = Database.prototype.parseExpectedColumns.call(
                { stripSqlLineComments: Database.prototype.stripSqlLineComments }, m[0]);
            if (!columns) continue;
            out.push({
                file, table: m[1],
                columns: columns.map(c => ({
                    name: c.name,
                    spec: normalizeSpec(c.definition.replace(new RegExp('^\\s*`?' + c.name + '`?\\s*', 'i'), '')),
                })),
                // Inline KEY/UNIQUE KEY clauses + the ENGINE/CHARSET tail: both are part of a
                // byte-identical SHOW CREATE TABLE, and neither is a "column", so they are
                // compared as a normalized body rather than per-column.
                body: normalizeCreateBody(m[0]),
            });
        }
    }
    return out;
}

// The whole CREATE TABLE block reduced to a comparable form: no backticks, collapsed
// whitespace, uppercased, and with the optional `IF NOT EXISTS` removed. Two blocks that
// compare equal produce the same SHOW CREATE TABLE.
function normalizeCreateBody(sql) {
    return String(sql)
        .replace(/`/g, '')
        .replace(/\bIF\s+NOT\s+EXISTS\s+/i, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*/g, ',')
        .replace(/\s*\(\s*/g, '(')
        .replace(/\s*\)\s*/g, ')')
        .trim()
        .toUpperCase();
}

const byFile = (x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0);

// Apply the later dated ALTERs onto a migration-created table's column list, so the result
// is the shape a replica that replayed the whole ledger actually holds.
//
// ADD COLUMN lands at its AFTER/FIRST anchor. An already-present name is skipped: an
// idempotent `ADD COLUMN IF NOT EXISTS` re-declaring an existing column adds nothing.
//
// MODIFY then restates a column in place, last file wins, which is the ONLY legal way to
// evolve a column of a migration-created table: the CREATE is checksum-immutable once
// applied (db.js runMigrations refuses a file whose content changed) and the boot-time
// drift reconciler adds a missing column without ever retyping an existing one. Composing
// the MODIFY here is what lets the definition move with a dated migration behind it; a
// definition edited alone still fails, because the composed shape no longer matches.
function composeLedgerColumns(created, laterAdds, laterMods) {
    const cols = created.columns.map(c => ({ name: c.name, spec: c.spec }));
    const at = (name) => cols.findIndex(c => c.name.toLowerCase() === String(name || '').toLowerCase());
    for (const a of (laterAdds || []).slice().sort(byFile)) {
        if (at(a.name) >= 0) continue;
        const entry = { name: a.name, spec: a.spec };
        if (a.first) { cols.unshift(entry); continue; }
        const anchor = a.after ? at(a.after) : -1;
        if (anchor >= 0) cols.splice(anchor + 1, 0, entry);
        else cols.push(entry);
    }
    for (const m of (laterMods || []).slice().sort(byFile)) {
        const i = at(m.name);
        if (i >= 0) cols[i] = { name: cols[i].name, spec: m.spec };
    }
    return cols;
}

// The part of a normalized CREATE body that no ADD COLUMN can change: the table-level
// key clauses and the ENGINE/CHARSET tail. Everything before the first key clause is the
// column list, which is compared separately and per column.
function bodyTail(body) {
    const m = String(body).match(/,(?:PRIMARY\s+KEY|UNIQUE\s+KEY|KEY|INDEX|FULLTEXT|CONSTRAINT)\b/);
    if (m) return String(body).slice(m.index);
    const eng = String(body).lastIndexOf(')ENGINE');
    return eng >= 0 ? String(body).slice(eng) : '';
}

// The definition file's own CREATE TABLE block, normalized the same way. Keyed by table.
function collectDefinitionBodies() {
    const out = {};
    for (const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'))) {
        const raw = stripComments(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'));
        const m   = raw.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\([\s\S]+?\)\s*(ENGINE[^;]*)/i);
        if (m) out[m[1]] = normalizeCreateBody(m[0]);
    }
    return out;
}

// Every column a dated migration retypes in place: { file, table, name, spec }.
// MODIFY cannot restate table-level constraints, so an inline PRIMARY KEY in the
// definition is normalized away before comparison (the key itself is untouched
// by a MODIFY; only the column shape must converge).
function collectMigrationModifies() {
    const out = [];
    // Sorted: apply order is lexical (db.js runMigrations), and the last-MODIFY-wins
    // reduction below depends on iterating files in that same order.
    for (const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
        const raw = stripComments(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
        for (const stmt of raw.split(';')) {
            const t = stmt.match(/ALTER\s+TABLE\s+`?(\w+)`?/i);
            if (!t) continue;
            for (const m of stmt.matchAll(/\bMODIFY\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?`?(\w+)`?([\s\S]*?)(?=,\s*MODIFY\s|,\s*ADD\s|,\s*DROP\s|$)/gi)) {
                out.push({ file, table: t[1], name: m[1], spec: normalizeSpec(m[2]) });
            }
        }
    }
    return out;
}

const stripInlineKeys = (spec) => spec.replace(/\s+(PRIMARY\s+KEY|UNIQUE(\s+KEY)?)\b/g, '').trim();

// `table.column` for every ADD COLUMN a STRICTLY LATER dated migration also MODIFYs.
// MariaDB's MODIFY restates the whole column, so once a later file retypes it the shape a
// replaying replica holds is the MODIFY's, never the ADD's - and applied files are
// checksum-immutable (db.js runMigrations), so a NEW dated MODIFY is the only legal way to
// evolve a column an old migration added. Comparing the historical ADD against today's
// definition therefore fails on a legitimately converged column and leaves it unfixable.
// Strictly later by filename only, because apply order is lexical filename order: an ADD and
// a MODIFY inside ONE file stay checked, since clause order within a file is not ledger order.
// Coverage is transferred, not dropped - the last-MODIFY-wins case below holds the definition
// equal to that final shape, and the AFTER/FIRST position case still checks the ADD's anchor
// (a bare MODIFY leaves position alone, but MODIFY ... AFTER/FIRST does move a column, so
// the ADD anchor this case checks can be made stale by a later repositioning MODIFY).
function supersededAdds() {
    const modifies = collectMigrationModifies();
    const out = new Set();
    for (const c of collectMigrationColumns()) {
        if (modifies.some(m => m.table === c.table &&
                               m.name.toLowerCase() === c.name.toLowerCase() &&
                               m.file > c.file))
            out.add(c.table + '.' + c.name.toLowerCase());
    }
    return out;
}

module.exports = {
    collectDefinitionColumns, collectMigrationColumns, collectMigrationCreatedTables,
    composeLedgerColumns, bodyTail, collectDefinitionBodies, collectMigrationModifies,
    stripInlineKeys, supersededAdds,
};

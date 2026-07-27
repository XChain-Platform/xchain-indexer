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
 * Schema COLUMN parity: the two schema-construction paths must agree.
 *
 * Sibling of sql-schema-index-parity.test.js, which proves the same thing for
 * indexes. The two construction paths:
 *   DEFINITION path - src/sql/<table>.sql, applied on a fresh install (createTable).
 *   LEDGER path     - src/sql/migrations/*.sql, replayed on a long-lived DB.
 *
 * Three ways they can silently diverge, one test each:
 *   1. PRESENCE - a migration adds a column no definition declares. Fresh installs
 *      never get it; baselining the migration would drop it for aged DBs too.
 *   2. SHAPE - the column exists in both paths but with a different type / nullability
 *      / default / generation expression, so the two DBs disagree on what it holds.
 *   3. POSITION - a migration adds the column with no AFTER clause (MariaDB appends
 *      at the tail) while the definition declares it mid-table. Logically equivalent,
 *      but not a byte-identical SHOW CREATE TABLE. This is exactly how
 *      contract_state.state_key_bin diverged: its INDEX was declared (so the index
 *      parity test above passed) while its column POSITION did not converge.
 *
 * Scope, stated plainly: this compares each migration's ADD COLUMN against the
 * definition it must converge to. It does NOT replay migrations against a live aged
 * schema, so it cannot catch a column that drifted through some path other than a
 * committed migration. MODIFY-only type changes (retypes of an existing column) are
 * checked by their own case below: the MODIFY's target spec must equal the definition,
 * so both paths converge on the same column shape.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
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
// a false provenance claim that then hid every later drift on that table (#3164).
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

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {

    it('sanity: the parser finds migration-added columns (guard is not vacuous)', function () {
        const cols = collectMigrationColumns();
        assert.ok(cols.length > 0,
            'found no ADD COLUMN in src/sql/migrations; the regexes above have gone stale and this ' +
            'whole guard would pass vacuously');
        // Pin the two shapes that exist today: a single-clause ALTER and a multi-clause
        // one, so a regex regression that silently drops one form is caught.
        assert.ok(cols.some(c => c.table === 'capability_snapshots' && c.name === 'source'), 'single-clause ADD COLUMN no longer parsed');
        assert.ok(cols.some(c => c.table === 'polls' && c.name === 'callback_method'), 'multi-clause ADD COLUMN no longer parsed');
    });

    it('sanity: the parser finds definition columns in source order', function () {
        const defs = collectDefinitionColumns();
        assert.ok(Object.keys(defs).length > 0, 'parsed no columns out of src/sql/*.sql');
        const cs = defs['contract_state'].map(c => c.name);
        assert.ok(cs.indexOf('state_key_bin') > cs.indexOf('state_key'), 'definition column ORDER no longer parsed');
    });

    it('no column exists only on the ledger path (every migration-added column is declared in its definition)', function () {
        const defs    = collectDefinitionColumns();
        const orphans = collectMigrationColumns().filter(c =>
            !(defs[c.table] || []).some(d => d.name.toLowerCase() === c.name.toLowerCase()));

        assert.deepStrictEqual(orphans, [],
            'These columns are added by a dated migration but are NOT declared in the table definition, so ' +
            'a fresh install never gets them. Declare each in src/sql/<table>.sql:\n' +
            orphans.map(o => `  ${o.table}.${o.name}  <- ${o.file}`).join('\n'));
    });

    it('a migration-added column has the same TYPE/nullability/default as its definition', function () {
        const defs      = collectDefinitionColumns();
        const mismatches = [];
        for (const c of collectMigrationColumns()) {
            const d = (defs[c.table] || []).find(x => x.name.toLowerCase() === c.name.toLowerCase());
            if (!d) continue;                                  // presence is the test above
            if (d.spec !== c.spec) mismatches.push({ table: c.table, name: c.name, file: c.file, definition: d.spec, migration: c.spec });
        }
        assert.deepStrictEqual(mismatches, [],
            'These columns are declared with a DIFFERENT shape on the two paths, so an aged DB and a fresh ' +
            'install disagree on what the column holds:\n' +
            mismatches.map(m => `  ${m.table}.${m.name} (${m.file})\n    definition: ${m.definition}\n    migration:  ${m.migration}`).join('\n'));
    });

    it('sanity: the parser finds migration MODIFY clauses (retype guard is not vacuous)', function () {
        const mods = collectMigrationModifies();
        // Pin the two shapes that exist today: a single-clause MODIFY (the 2026-06-10
        // id repair) and a multi-clause one (the 2026-07-16 signedness align).
        assert.ok(mods.some(m => m.file.startsWith('2026-06-10') && m.table === 'price_snapshots' && m.name === 'id'),
            'single-clause MODIFY no longer parsed');
        assert.ok(mods.some(m => m.file.startsWith('2026-07-16') && m.table === 'cross_chain_calls' && m.name === 'gas_limit'),
            'multi-clause MODIFY no longer parsed');
    });

    it('a migration-retyped column converges on its DEFINITION shape (last MODIFY wins)', function () {
        const defs = collectDefinitionColumns();
        // Migrations replay in lexical filename order, so only the LAST MODIFY of a
        // column must match the definition; an earlier one (e.g. the 2026-06-10 signed
        // id repair, superseded by the 2026-07-16 unsigned align) is legitimately stale.
        const last = new Map();
        for (const m of collectMigrationModifies()) last.set(m.table + '.' + m.name.toLowerCase(), m);

        const mismatches = [];
        for (const m of last.values()) {
            const d = (defs[m.table] || []).find(x => x.name.toLowerCase() === m.name.toLowerCase());
            assert.ok(d, m.file + ' MODIFYs ' + m.table + '.' + m.name + ' but no definition declares that column');
            if (stripInlineKeys(d.spec) !== stripInlineKeys(m.spec))
                mismatches.push({ table: m.table, name: m.name, file: m.file, definition: d.spec, migration: m.spec });
        }
        assert.deepStrictEqual(mismatches, [],
            'These columns are RETYPED by a migration to a different shape than the definition declares, so an ' +
            'aged DB and a fresh install disagree on what the column holds:\n' +
            mismatches.map(m => `  ${m.table}.${m.name} (${m.file})\n    definition: ${m.definition}\n    migration:  ${m.migration}`).join('\n'));
    });

    it('a migration-added column lands in the DEFINITION\'s column position (AFTER/FIRST anchor)', function () {
        const defs     = collectDefinitionColumns();
        const misplaced = [];
        for (const c of collectMigrationColumns()) {
            const cols = defs[c.table] || [];
            const i    = cols.findIndex(x => x.name.toLowerCase() === c.name.toLowerCase());
            if (i < 0) continue;                               // presence is the test above
            const expectedAnchor = i === 0 ? null : cols[i - 1].name;   // null => must be FIRST
            const actualAnchor   = c.after;

            if (expectedAnchor === null) {
                if (!c.first) misplaced.push({ ...c, want: 'FIRST', got: actualAnchor ? 'AFTER ' + actualAnchor : '(appended)' });
                continue;
            }
            if (!actualAnchor || actualAnchor.toLowerCase() !== expectedAnchor.toLowerCase()) {
                misplaced.push({ ...c, want: 'AFTER ' + expectedAnchor, got: actualAnchor ? 'AFTER ' + actualAnchor : '(appended: no AFTER clause)' });
            }
        }
        assert.deepStrictEqual(misplaced, [],
            'MariaDB APPENDS a column with no AFTER clause, so these migrations land the column at a different ' +
            'position than the definition declares. The schemas stay logically equivalent but are no longer a ' +
            'byte-identical SHOW CREATE TABLE (this is how contract_state.state_key_bin diverged):\n' +
            misplaced.map(m => `  ${m.table}.${m.name} (${m.file}): want ${m.want}, got ${m.got}`).join('\n'));
    });

    // #2457: the three cases above all run ledger->definition (every migration-added
    // column is checked against the definition). This closes the INVERSE direction:
    // a column added to a definition file with NO dated migration is invisible to a
    // DB converged by replaying migrations alone (operator-managed / rebuilt replica),
    // which silently ends up short of the column. Baseline = columns that predate the
    // ledger and legitimately need no migration (test/fixtures/schema-baseline.json).
    it('no column exists only on the definition path (every definition column is baselined or migration-added) @regression', function () {
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', 'fixtures', 'schema-baseline.json'), 'utf8'));
        const baselineCols   = baseline.baseline || {};
        const knownUnledgered = new Set((baseline.known_unledgered || []).map(s => s.toLowerCase()));

        // Columns any dated migration ADDs, as `table.col` (reuses the proven parser).
        const migrated = new Set(collectMigrationColumns().map(c => (c.table + '.' + c.name).toLowerCase()));
        // Plus every column of a table a dated migration CREATEs outright: those arrive on
        // the ledger path through the CREATE TABLE, not an ADD COLUMN (#3164).
        for (const t of collectMigrationCreatedTables())
            for (const c of t.columns) migrated.add((t.table + '.' + c.name).toLowerCase());

        const orphans = [];
        for (const [table, cols] of Object.entries(collectDefinitionColumns())) {
            const based = new Set((baselineCols[table] || []).map(s => s.toLowerCase()));
            for (const c of cols) {
                const key  = (table + '.' + c.name).toLowerCase();
                if (based.has(c.name.toLowerCase())) continue;   // predates the ledger
                if (migrated.has(key)) continue;                 // a dated migration adds it
                if (knownUnledgered.has(key)) continue;          // tracked debt, awaiting its migration
                orphans.push(table + '.' + c.name);
            }
        }
        assert.deepStrictEqual(orphans, [],
            'These columns are declared in a src/sql/<table>.sql definition but no dated migration under ' +
            'src/sql/migrations/ adds them, so a replica converged by replaying migrations alone never gains ' +
            'them. Ship a dated migration (ADD COLUMN IF NOT EXISTS ... with the AFTER anchor matching the ' +
            'definition). If the column genuinely predates the migration ledger, add it to ' +
            'test/fixtures/schema-baseline.json deliberately:\n  ' + orphans.join('\n  '));
    });

    // #3164: the guard above had no notion of a migration-created TABLE. Its columns are
    // neither pre-ledger nor ADD COLUMN-ed, so the only way to quiet the definition-path
    // check was to list the table in the PRE-LEDGER baseline - which is false (the table
    // does not predate the ledger; a migration creates it) and, worse, permanently exempts
    // every one of its columns from parity, so the migration's CREATE TABLE could drift
    // from the definition unnoticed. These three cases replace that hiding place with a
    // real gate.
    it('sanity: the parser finds migration-created tables (CREATE TABLE guard is not vacuous)', function () {
        const created = collectMigrationCreatedTables();
        assert.ok(created.length > 0,
            'found no CREATE TABLE in src/sql/migrations; the regex above has gone stale and the ' +
            'migration-created-table cases below would pass vacuously');
        const anchorAttest = created.find(t => t.table === 'anchor_reward_attestations');
        assert.ok(anchorAttest, 'the 2026-07-21 anchor_reward_attestations CREATE TABLE is no longer parsed');
        assert.ok(anchorAttest.columns.length >= 10, 'CREATE TABLE columns no longer parsed out of the migration');
    });

    it('a migration-created table matches its definition byte-for-byte (columns, keys, engine)', function () {
        const bodies    = collectDefinitionBodies();
        const mismatches = [];
        for (const t of collectMigrationCreatedTables()) {
            if (!bodies[t.table]) { mismatches.push({ table: t.table, file: t.file, reason: 'no src/sql/' + t.table + '.sql definition declares this table' }); continue; }
            if (bodies[t.table] !== t.body) mismatches.push({ table: t.table, file: t.file, reason: 'CREATE TABLE differs from the definition', definition: bodies[t.table], migration: t.body });
        }
        assert.deepStrictEqual(mismatches, [],
            'A dated migration CREATEs these tables, so a fresh install (createTable from the definition) and a ' +
            'DB converged by replaying migrations must end up with the IDENTICAL table. They do not:\n' +
            mismatches.map(m => `  ${m.table} (${m.file}): ${m.reason}` +
                (m.definition ? `\n    definition: ${m.definition}\n    migration:  ${m.migration}` : '')).join('\n'));
    });

    it('a migration-created table is NOT parked in the pre-ledger baseline', function () {
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', 'fixtures', 'schema-baseline.json'), 'utf8'));
        const based  = new Set(Object.keys(baseline.baseline || {}));
        const parked = collectMigrationCreatedTables().filter(t => based.has(t.table));

        assert.deepStrictEqual(parked.map(t => t.table + ' <- ' + t.file), [],
            'These tables are CREATEd by a dated migration, so they do NOT predate the migration ledger and must ' +
            'not sit in test/fixtures/schema-baseline.json. Baselining them claims their columns need no ' +
            'migration and exempts the whole table from column parity forever, so the migration\'s CREATE TABLE ' +
            'can silently drift from src/sql/<table>.sql. Remove the entry; the migration-created-table case ' +
            'above is what covers them.');
    });

    it('sanity: the baseline fixture is not vacuous and references only real tables', function () {
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', 'fixtures', 'schema-baseline.json'), 'utf8'));
        const defs = collectDefinitionColumns();
        assert.ok(Object.keys(baseline.baseline || {}).length > 50, 'baseline should cover the bulk of tables');
        for (const table of Object.keys(baseline.baseline || {})) {
            assert.ok(defs[table], 'baseline references unknown table ' + table);
        }
    });
});

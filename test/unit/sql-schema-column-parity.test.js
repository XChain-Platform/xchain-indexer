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
 * committed migration, and it does not check MODIFY-only type changes against the
 * definition (no committed migration does that today; add a case here when one does).
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
});

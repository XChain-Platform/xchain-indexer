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
 * so both paths converge on the same column shape. An ADD later retyped by a dated MODIFY
 * hands its shape check to that case (see supersededAdds), because applied files are
 * checksum-immutable and a new dated MODIFY is the only legal way to evolve such a column.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');
const { loadPinnedOriginFixture } = require('../helpers/pinnedOriginFixture');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');

// #5404: the immutable anchor the re-freeze guard measures against, plus the sha256 that
// makes editing it a deliberate act. See the re-freeze case at the bottom of this file.
const ORIGIN_BASELINE        = path.join(__dirname, '..', 'fixtures', 'schema-baseline-origin.json');
const ORIGIN_BASELINE_SHA256 = 'b9f13cbbf4d6c8c746a1ba15fb56eb20934b46d269d3194370c3852839515c45';

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

// Apply later dated ADD COLUMN migrations onto a migration-created table's column list,
// at each one's AFTER/FIRST anchor, so the result is the shape a replica that replayed the
// whole ledger actually holds. Already-present names are skipped: an idempotent
// `ADD COLUMN IF NOT EXISTS` re-declaring an existing column adds nothing.
function composeLedgerColumns(created, laterAdds) {
    const cols = created.columns.map(c => ({ name: c.name, spec: c.spec }));
    const at = (name) => cols.findIndex(c => c.name.toLowerCase() === String(name || '').toLowerCase());
    for (const a of laterAdds.slice().sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0))) {
        if (at(a.name) >= 0) continue;
        const entry = { name: a.name, spec: a.spec };
        if (a.first) { cols.unshift(entry); continue; }
        const anchor = a.after ? at(a.after) : -1;
        if (anchor >= 0) cols.splice(anchor + 1, 0, entry);
        else cols.push(entry);
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

// Parse a normalized CREATE body's ENGINE / CHARSET / COLLATE tail into its three fields.
// Parsed rather than text-compared because `DEFAULT CHARSET=x` and `CHARSET=x` are the same
// DDL to MariaDB (markets.sql writes the second). Null when the body carries no tail.
function engineTail(body) {
    const i = String(body).lastIndexOf(')ENGINE');
    if (i < 0) return null;
    const tail = String(body).slice(i);
    const eng  = tail.match(/ENGINE=(\w+)/);
    const cs   = tail.match(/CHARSET=(\w+)/);
    const co   = tail.match(/COLLATE=(\w+)/);
    return {
        engine:  eng ? eng[1] : null,
        charset: cs  ? cs[1]  : null,
        collate: co  ? co[1]  : null,
    };
}

// What the fleet's tables are declared as. Normalized bodies are uppercased.
const FLEET_TABLE_ENGINE  = 'INNODB';
const FLEET_TABLE_CHARSET = 'UTF8';
const FLEET_TABLE_COLLATE = 'UTF8_GENERAL_CI';

// Tables whose table-level charset is deliberately NOT the fleet default, each with its
// reason. The tail is the one schema attribute neither convergence path touches and no
// reconciler heals, and a column declaring no charset of its own inherits it - so editing
// a tail re-collates that column on fresh installs while aged databases keep the old one.
// An in-code map rather than a frozen fixture: a fixture is silenced by regenerating it in
// the same commit, this one only by writing a false justification into a reviewed file.
const TABLE_CHARSET_EXEMPTIONS = {
    index_tickers: {
        charset: 'UTF8MB4',
        collate: 'UTF8MB4_BIN',
        why: 'tick declares no charset of its own, so this tail IS its collation, and the ' +
             'consensus reads pin it literally (ORDER BY ... tick COLLATE utf8mb4_bin in ' +
             'src/stateHash.js and src/db.js). Against a utf8mb3 column MariaDB raises ' +
             'ER_COLLATION_CHARSET_MISMATCH (1253) rather than sorting differently, so this ' +
             'tail is load-bearing for block hashing, not cosmetic.',
    },
};

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
        const superseded = supersededAdds();
        const mismatches = [];
        for (const c of collectMigrationColumns()) {
            const d = (defs[c.table] || []).find(x => x.name.toLowerCase() === c.name.toLowerCase());
            if (!d) continue;                                  // presence is the test above
            // ADD(old shape) + later MODIFY(new shape) is a converged path, not a divergence:
            // the last-MODIFY-wins case below is what holds it to the definition.
            if (superseded.has(c.table + '.' + c.name.toLowerCase())) continue;
            if (d.spec !== c.spec) mismatches.push({ table: c.table, name: c.name, file: c.file, definition: d.spec, migration: c.spec });
        }
        assert.deepStrictEqual(mismatches, [],
            'These columns are declared with a DIFFERENT shape on the two paths, so an aged DB and a fresh ' +
            'install disagree on what the column holds:\n' +
            mismatches.map(m => `  ${m.table}.${m.name} (${m.file})\n    definition: ${m.definition}\n    migration:  ${m.migration}`).join('\n'));
    });

    // The skip above is the one place this guard can be quieted without a code change, so the
    // exempt set is PINNED rather than merely computed: a new entry appears only when someone
    // edits this list, which is the reviewed act. A bare "recompute and compare" assertion here
    // would pass vacuously and give the exemption away silently.
    it('sanity: the ADD-shape supersession exempts only the reviewed set', function () {
        assert.deepStrictEqual([...supersededAdds()].sort(), [
            // 2026-07-10 ADDed it, 2026-07-16-reposition-state-key-bin.sql MODIFYs it into
            // position; the last-MODIFY-wins case holds that MODIFY equal to contract_state.sql.
            'contract_state.state_key_bin',
        ],
        'The set of ADD COLUMNs exempted from the shape comparison changed. Each entry is a column ' +
        'whose shape is now enforced ONLY through the last-MODIFY-wins case, so add one here only ' +
        'after confirming a strictly-later dated migration really does MODIFY it to the definition ' +
        'shape - and remove one when its superseding migration goes away.');
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
            const based = new Set((baselineCols[table] || []).map(e => String(e.name).toLowerCase()));
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

    // #4435: the guard above exempts a pre-ledger column by NAME alone, and the baseline used
    // to store nothing but names. So a definition-only SHAPE change to a baselined column -
    // widening `balances.amount VARCHAR(250)`, flipping its nullability or default, or moving
    // it among its pre-ledger siblings - stayed green with no dated migration behind it. That
    // is not a theoretical hole: the boot-time drift reconciler (`alterTableForDrift` in
    // src/db.js) adds MISSING columns but never retypes an existing one, so an aged DB keeps
    // the old shape forever while a fresh install gets the new one, and the two schema paths
    // silently disagree. The baseline now freezes each pre-ledger column's normalized spec in
    // definition order, which is the same value collectDefinitionColumns() produces, so this
    // compares like with like through one parser.
    //
    // Position is asserted RELATIVELY (the order of the baselined columns among themselves),
    // not as an absolute index. A dated migration that legitimately inserts a column mid-table
    // shifts every later absolute index, which would make an absolute check fail on correct
    // work; relative order is untouched by that and still catches a reorder of the pre-ledger
    // columns, which is what breaks byte-identity.
    it('a pre-ledger baselined column has not changed shape or relative position @regression', function () {
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', 'fixtures', 'schema-baseline.json'), 'utf8'));
        const defs = collectDefinitionColumns();

        const drifted   = [];
        const reordered = [];
        for (const [table, frozen] of Object.entries(baseline.baseline || {})) {
            const cols = defs[table] || [];
            const want = new Map(frozen.map(e => [String(e.name).toLowerCase(), e]));
            const live = cols.filter(c => want.has(c.name.toLowerCase()));

            const liveOrder   = live.map(c => c.name.toLowerCase()).join(',');
            const frozenOrder = frozen.map(e => String(e.name).toLowerCase()).join(',');
            if (liveOrder !== frozenOrder)
                reordered.push(`  ${table}: definition order [${liveOrder}] vs baseline [${frozenOrder}]`);

            for (const c of live) {
                const e = want.get(c.name.toLowerCase());
                if (e.spec !== c.spec)
                    drifted.push(`  ${table}.${c.name}\n    baseline:   ${e.spec}\n    definition: ${c.spec}`);
            }
        }

        assert.deepStrictEqual(drifted, [],
            'These columns predate the migration ledger, so they are exempt from needing a dated migration - ' +
            'but their SHAPE changed in src/sql/<table>.sql with no migration behind it. A long-lived DB will ' +
            'never converge: alterTableForDrift (src/db.js) adds missing columns but never retypes an existing ' +
            'one, so aged DBs keep the old type/default/nullability while fresh installs get the new one. Ship ' +
            'a dated migration with the matching MODIFY (the MODIFY-parity case above then enforces it), and ' +
            're-freeze test/fixtures/schema-baseline.json in the SAME commit:\n' + drifted.join('\n'));

        assert.deepStrictEqual(reordered, [],
            'The pre-ledger columns of these tables changed order relative to each other in ' +
            'src/sql/<table>.sql. MariaDB cannot reorder a column in place, so an aged DB keeps the original ' +
            'order and the two paths stop producing a byte-identical SHOW CREATE TABLE (the way ' +
            'contract_state.state_key_bin diverged). Restore the declared order, or - if the move is ' +
            'deliberate and carried by a dated migration - re-freeze test/fixtures/schema-baseline.json in ' +
            'the same commit:\n' + reordered.join('\n'));
    });

    // #5404: the guard above enforces only HALF of the remedy its own failure message
    // mandates. It fires when baseline != definition, and the mandated fix is "ship a dated
    // migration with the matching MODIFY, AND re-freeze this fixture in the SAME commit".
    // Only the re-freeze is machine-checked. Doing the re-freeze ALONE restores
    // baseline == definition and turns the guard green with no migration behind it, so every
    // aged DB and every replay-only replica keeps the old column shape forever
    // (alterTableForDrift adds a MISSING column but never retypes an existing one) - the exact
    // divergence #4435 closed, one `git add` away.
    //
    // Enforcing the other half needs an ANCHOR: "this entry was re-frozen" is not derivable
    // from a fixture that has just been rewritten, and nothing else in the tree remembers the
    // old shape. test/fixtures/schema-baseline-origin.json is that anchor, sha256-pinned in
    // ORIGIN_BASELINE_SHA256 above; any entry whose frozen shape has moved off it must name a
    // dated migration whose LAST MODIFY carries the new shape. That is the same convergence
    // condition the last-MODIFY-wins case asserts, read from the other end: there a migration
    // must match the definition, here a moved definition must have a migration.
    //
    // The anchor is seeded from the #4435 landing (01f321c1), NOT from today's baseline, and
    // the difference is the whole guard. An anchor copied from today is vacuous: nothing
    // differs from it, so this case checks nothing and would first do work on some future
    // commit that nobody ever watched it fail on. Seeded from #4435 it already carries
    // sixteen divergences - the fifteen utf8mb4 column re-freezes and destroys.action_index
    // on the index side - so both shipped re-freezes are resolved through their real
    // migrations by this case today, and the sanity test below pins that.
    //
    // Comparison basis is stripInlineKeys on BOTH sides, exactly as the last-MODIFY-wins case
    // compares: MariaDB's MODIFY cannot restate a table-level key, so detecting drift on a
    // basis no MODIFY can reach would raise failures with no legal remedy.
    it('a re-frozen pre-ledger column is backed by a dated migration that converges aged DBs @regression', function () {
        const origin   = loadPinnedOriginFixture(ORIGIN_BASELINE, ORIGIN_BASELINE_SHA256,
                                                 'test/unit/sql-schema-column-parity.test.js');
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', 'fixtures', 'schema-baseline.json'), 'utf8'));

        // Migrations replay in lexical filename order, so the shape an aged DB actually ends
        // up with is the LAST MODIFY's - the same reduction the case above uses.
        const lastModify = new Map();
        for (const m of collectMigrationModifies()) lastModify.set(m.table + '.' + m.name.toLowerCase(), m);

        const unjustified = [];
        const minted      = [];
        for (const [table, frozen] of Object.entries(baseline.baseline || {})) {
            const anchored = new Map(((origin.baseline || {})[table] || [])
                .map(e => [String(e.name).toLowerCase(), String(e.spec)]));
            for (const e of frozen) {
                const name = String(e.name).toLowerCase();
                if (!anchored.has(name)) { minted.push(`  ${table}.${e.name}  (frozen as: ${e.spec})`); continue; }
                if (stripInlineKeys(anchored.get(name)) === stripInlineKeys(String(e.spec))) continue;
                const m = lastModify.get(table + '.' + name);
                if (m && stripInlineKeys(m.spec) === stripInlineKeys(String(e.spec))) continue;
                unjustified.push(`  ${table}.${e.name}\n    origin:    ${anchored.get(name)}\n    re-frozen: ${e.spec}\n    ` +
                    (m ? `last MODIFY (${m.file}): ${m.spec}` : 'no dated migration MODIFYs this column'));
            }
        }

        assert.deepStrictEqual(unjustified, [],
            'These pre-ledger columns were RE-FROZEN in test/fixtures/schema-baseline.json - their spec no ' +
            'longer matches test/fixtures/schema-baseline-origin.json - but no dated migration under ' +
            'src/sql/migrations/ MODIFYs them to the re-frozen shape. The re-freeze silences the shape guard ' +
            'above for fresh installs while every long-lived DB and every replay-only replica keeps the ' +
            'ORIGINAL shape forever, which is the divergence that guard exists to prevent. Ship the dated ' +
            'migration the guard\'s own failure message asks for (ALTER TABLE ... MODIFY, spec identical to ' +
            'the definition), or revert the definition and the re-freeze together:\n' + unjustified.join('\n'));

        assert.deepStrictEqual(minted, [],
            'These columns were ADDED to test/fixtures/schema-baseline.json but are absent from ' +
            'test/fixtures/schema-baseline-origin.json, so they do not predate the migration ledger and the ' +
            'baseline is claiming a provenance they do not have. Baselining exempts a column from needing a ' +
            'migration forever, so a replay-only replica never gains it. Ship a dated ADD COLUMN migration ' +
            'instead, or list it under known_unledgered while its migration is owed:\n' + minted.join('\n'));
    });

    // #5404, second half: the case above closes the SHAPE bypass, this one closes the ORDER
    // bypass in the same guard. The #4435 case asserts baseline order == definition order, so
    // reordering the pre-ledger columns of a table AND re-freezing the fixture in one commit
    // is green, while an aged DB keeps the original order and the two paths stop producing a
    // byte-identical SHOW CREATE TABLE. Anchoring the order kills that. No migration escape
    // hatch is offered here even though MODIFY ... AFTER can reposition a column: a
    // repositioning MODIFY also restates the whole column and is a rewrite of the table, so
    // the deliberate path is a reviewed anchor bump, not an assertion this case tries to
    // second-guess.
    it('the pre-ledger columns have not been re-ordered since the origin anchor @regression', function () {
        const origin   = loadPinnedOriginFixture(ORIGIN_BASELINE, ORIGIN_BASELINE_SHA256,
                                                 'test/unit/sql-schema-column-parity.test.js');
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', 'fixtures', 'schema-baseline.json'), 'utf8'));

        const reordered = [];
        for (const [table, frozen] of Object.entries(baseline.baseline || {})) {
            const anchor = ((origin.baseline || {})[table] || []).map(e => String(e.name).toLowerCase());
            if (anchor.length === 0) continue;                     // a wholly new table: the minted case owns it
            const anchorSet = new Set(anchor);
            const nowSet    = new Set(frozen.map(e => String(e.name).toLowerCase()));
            // Compare only the columns BOTH lists carry: a legitimately removed or added entry
            // is adjudicated by the cases above, and must not be read here as a reorder.
            const nowOrder    = frozen.map(e => String(e.name).toLowerCase()).filter(n => anchorSet.has(n)).join(',');
            const anchorOrder = anchor.filter(n => nowSet.has(n)).join(',');
            if (nowOrder !== anchorOrder)
                reordered.push(`  ${table}: baseline [${nowOrder}] vs origin [${anchorOrder}]`);
        }

        assert.deepStrictEqual(reordered, [],
            'The pre-ledger columns of these tables were re-ordered in test/fixtures/schema-baseline.json ' +
            'relative to test/fixtures/schema-baseline-origin.json. MariaDB cannot reorder a column in ' +
            'place, so a re-freeze here quiets the relative-position guard above while every aged DB keeps ' +
            'the original order and the two schema paths stop producing a byte-identical SHOW CREATE TABLE. ' +
            'Restore the declared order in src/sql/<table>.sql and the fixture together:\n' + reordered.join('\n'));
    });

    // The anchor is only worth what it differs from. Seeding it from today's baseline would
    // leave both cases above passing over an empty set forever, and a re-anchor that quietly
    // absorbs the current baseline has the same effect - so pin that the anchor still carries
    // the two re-freezes we know shipped, each of which the case above resolves through its
    // real migration (utf8mb4 via 2026-08-19-utf8mb4-user-text-columns.sql and its
    // mode=manual index_memos twin; destroys.action_index in the index sibling).
    it('sanity: the origin anchor still differs from the live baseline (re-freeze guard is not vacuous)', function () {
        const origin   = loadPinnedOriginFixture(ORIGIN_BASELINE, ORIGIN_BASELINE_SHA256,
                                                 'test/unit/sql-schema-column-parity.test.js');
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', 'fixtures', 'schema-baseline.json'), 'utf8'));

        const moved = [];
        for (const [table, frozen] of Object.entries(baseline.baseline || {})) {
            const anchored = new Map(((origin.baseline || {})[table] || [])
                .map(e => [String(e.name).toLowerCase(), String(e.spec)]));
            for (const e of frozen) {
                const name = String(e.name).toLowerCase();
                if (anchored.has(name) && stripInlineKeys(anchored.get(name)) !== stripInlineKeys(String(e.spec)))
                    moved.push(table + '.' + name);
            }
        }

        assert.ok(moved.length > 0,
            'No baseline entry differs from test/fixtures/schema-baseline-origin.json, so the re-freeze ' +
            'guard above is passing over an EMPTY set and proves nothing. The anchor has been re-seeded ' +
            'from the current baseline, which is the one way to make it vacuous.');
        assert.ok(moved.includes('index_memos.memo'),
            'index_memos.memo is the landmark re-freeze this guard is calibrated on (utf8mb3 -> utf8mb4, ' +
            'carried by 2026-08-19-utf8mb4-index-memos-memo.sql). It no longer differs from the anchor, so ' +
            'the anchor moved rather than the column.');
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
        const bodies     = collectDefinitionBodies();
        const defCols    = collectDefinitionColumns();
        const adds       = collectMigrationColumns();
        const mismatches = [];
        for (const t of collectMigrationCreatedTables()) {
            if (!bodies[t.table]) { mismatches.push({ table: t.table, file: t.file, reason: 'no src/sql/' + t.table + '.sql definition declares this table' }); continue; }
            // A migration-created table is not frozen at its CREATE. When it later gains a
            // column the CREATE cannot be edited (db.js enforces migration immutability by
            // checksum), so the shape a replaying replica converges to is CREATE + every
            // LATER dated ALTER, and THAT is what must equal the definition. Compare that
            // composed shape: columns (name + normalized spec, in position) plus the
            // non-column tail (keys + ENGINE), which no ADD COLUMN can change.
            const later = adds.filter(a => a.table === t.table && a.file > t.file);
            if (later.length === 0) {
                if (bodies[t.table] !== t.body) mismatches.push({ table: t.table, file: t.file, reason: 'CREATE TABLE differs from the definition', definition: bodies[t.table], migration: t.body });
                continue;
            }
            const composed = composeLedgerColumns(t, later);
            const want     = defCols[t.table] || [];
            if (JSON.stringify(composed) !== JSON.stringify(want))
                mismatches.push({ table: t.table, file: t.file,
                    reason: 'CREATE TABLE + later ADD COLUMN migrations do not compose to the definition columns',
                    definition: JSON.stringify(want), migration: JSON.stringify(composed) });
            else if (bodyTail(bodies[t.table]) !== bodyTail(t.body))
                mismatches.push({ table: t.table, file: t.file,
                    reason: 'keys/ENGINE tail differs from the definition',
                    definition: bodyTail(bodies[t.table]), migration: bodyTail(t.body) });
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

    it('sanity: the ENGINE/CHARSET tail parses for every definition (tail guard is not vacuous)', function () {
        const bodies = collectDefinitionBodies();
        assert.ok(Object.keys(bodies).length > 50,
            'collectDefinitionBodies no longer parses the definitions, so the tail case below would pass vacuously');
        const unparsed = Object.entries(bodies)
            .filter(([, body]) => {
                const t = engineTail(body);
                return !t || !t.engine || !t.charset || !t.collate;
            })
            .map(([table]) => table);
        assert.deepStrictEqual(unparsed, [],
            'These definitions declare no readable ENGINE / CHARSET / COLLATE tail, so the guard below ' +
            'cannot see their table-level collation at all. A CREATE TABLE that omits the tail inherits ' +
            'the SERVER default, which differs between hosts and between a fresh install and a restore: ' +
            'declare it explicitly.');
    });

    it('a table-level CHARSET/COLLATE tail is the fleet default or a declared exemption @regression', function () {
        const bodies    = collectDefinitionBodies();
        const offenders = [];
        for (const [table, body] of Object.entries(bodies)) {
            const tail = engineTail(body);
            if (!tail) continue;   // covered by the sanity case above
            const want = TABLE_CHARSET_EXEMPTIONS[table] ||
                         { charset: FLEET_TABLE_CHARSET, collate: FLEET_TABLE_COLLATE };
            if (tail.engine !== FLEET_TABLE_ENGINE)
                offenders.push(table + ': ENGINE=' + tail.engine + ', expected ' + FLEET_TABLE_ENGINE);
            if (tail.charset !== want.charset || tail.collate !== want.collate)
                offenders.push(table + ': ' + tail.charset + ' / ' + tail.collate +
                    ', expected ' + want.charset + ' / ' + want.collate +
                    (TABLE_CHARSET_EXEMPTIONS[table] ? ' (declared exemption)' : ' (fleet default)'));
        }
        assert.deepStrictEqual(offenders, [],
            'The table-level charset/collation of these definitions is neither the fleet default nor a ' +
            'declared exemption:\n  ' + offenders.join('\n  ') + '\n' +
            'This tail is healed by NOTHING. alterTableForDrift only ADDs columns and RELAXES nullability ' +
            '(it never issues ALTER TABLE ... CONVERT TO CHARACTER SET), reconcileTableIndexes only ADDs ' +
            'indexes, and the migration-created-table case in this file compares a tail only for tables a ' +
            'dated migration CREATEs - a pre-ledger table\'s tail is compared by neither schema path. So a ' +
            'change here re-collates every column that declares no charset of its own on FRESH installs ' +
            'while every aged database silently keeps the old one, and where a consensus read pins the ' +
            'collation literally the aged database fails the query outright (ER_COLLATION_CHARSET_MISMATCH, ' +
            'errno 1253) instead of merely sorting differently.\n' +
            'If the change is deliberate: ship a dated ALTER TABLE ... CONVERT TO CHARACTER SET migration ' +
            'under src/sql/migrations/ that converges aged databases, and add the table to ' +
            'TABLE_CHARSET_EXEMPTIONS in this file with the reason. Otherwise restore the tail.');
    });

    it('sanity: every declared charset exemption is a real table that still needs one', function () {
        const bodies = collectDefinitionBodies();
        const stale  = [];
        for (const [table, want] of Object.entries(TABLE_CHARSET_EXEMPTIONS)) {
            if (!bodies[table]) { stale.push(table + ': no src/sql/' + table + '.sql definition declares this table'); continue; }
            assert.ok(want.why && want.why.length > 40,
                'the ' + table + ' charset exemption carries no reason; an unexplained exemption is a silent waiver');
            const tail = engineTail(bodies[table]);
            if (tail && tail.charset === FLEET_TABLE_CHARSET && tail.collate === FLEET_TABLE_COLLATE)
                stale.push(table + ': is back on the fleet default, so the exemption now waives a guard nothing needs');
        }
        assert.deepStrictEqual(stale, [],
            'These TABLE_CHARSET_EXEMPTIONS entries are stale:\n  ' + stale.join('\n  ') + '\n' +
            'A stale exemption is worse than none: it silently pre-approves any future charset change on ' +
            'that table. Remove it.');
    });
});

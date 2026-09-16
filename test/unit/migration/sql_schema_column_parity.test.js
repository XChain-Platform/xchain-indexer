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
 * Sibling of sql_schema_index_parity.test.js, which proves the same thing for
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
 *
 * The cases are split by behaviour into files beside this one: the ledger-path
 * checks stay here, the pre-ledger baseline and its re-freeze origin anchor are in
 * sql_schema_column_parity.test/baseline.test.js, and migration-created tables and
 * the table-level charset tail are in sql_schema_column_parity.test/table_bodies.test.js.
 * The schema parsers all three read through are in sql_schema_column_parity.test/helpers/.
 ********************************************************************/

const assert = require('assert');

const {
    collectDefinitionColumns, collectMigrationColumns, collectMigrationModifies, stripInlineKeys, supersededAdds,
} = require('./sql_schema_column_parity.test/helpers/column_ledger.js');

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
});

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
    // The skip above is the one place this guard can be quieted without a code change, so the
    // exempt set is PINNED rather than merely computed: a new entry appears only when someone
    // edits this list, which is the reviewed act. A bare "recompute and compare" assertion here
    // would pass vacuously and give the exemption away silently.
    it('sanity: the ADD-shape supersession exempts only the reviewed set', function () {
        assert.deepStrictEqual([...supersededAdds()].sort(), [
            // 2026-07-10 ADDed it, 2026-07-16-reposition-state-key-bin.sql MODIFYs it into
            // position; the last-MODIFY-wins case holds that MODIFY equal to contract_state.sql.
            'contract_state.state_key_bin',
            // 2026-07-29-gated-files-threshold-and-publisher.sql ADDed it as plain
            // VARCHAR(40) NULL; 2026-09-02-utf8mb4-raw-wire-fields.sql MODIFYs it to utf8mb4
            // (GATE_MIN_AMOUNT is a raw wire field, persisted whether the FILE parsed or not).
            'gated_files.gate_min_amount',
            // Both ADDed by 2026-07-05-polls-binding-callback-columns.sql and MODIFYed to
            // utf8mb4 by 2026-09-02-utf8mb4-raw-wire-fields.sql, same raw-wire-field reason.
            'polls.callback_method',
            'polls.gas_escrow',
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
});

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
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
});

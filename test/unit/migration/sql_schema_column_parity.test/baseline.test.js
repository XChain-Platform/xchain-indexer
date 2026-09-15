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
 * Column parity, pre-ledger baseline half: every definition column is baselined
 * or migration-added, a baselined column keeps its shape and relative position,
 * and a re-frozen one is backed by a dated migration measured against the pinned
 * origin anchor. Part of the column parity suite; see
 * ../sql_schema_column_parity.test.js.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { loadPinnedOriginFixture } = require('../../../helpers/pinnedOriginFixture');
const {
    collectDefinitionColumns, collectMigrationColumns, collectMigrationCreatedTables,
    collectMigrationModifies, stripInlineKeys,
} = require('./helpers/column_ledger.js');

// The immutable anchor the re-freeze guard measures against, plus the sha256 that
// makes editing it a deliberate act. See the re-freeze case at the bottom of this file.
const ORIGIN_BASELINE        = path.join(__dirname, '..', '..', '..', 'fixtures', 'schema-baseline-origin.json');
const ORIGIN_BASELINE_SHA256 = 'b9f13cbbf4d6c8c746a1ba15fb56eb20934b46d269d3194370c3852839515c45';

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
    // The three cases above all run ledger->definition (every migration-added
    // column is checked against the definition). This closes the INVERSE direction:
    // a column added to a definition file with NO dated migration is invisible to a
    // DB converged by replaying migrations alone (operator-managed / rebuilt replica),
    // which silently ends up short of the column. Baseline = columns that predate the
    // ledger and legitimately need no migration (test/fixtures/schema-baseline.json).
    it('no column exists only on the definition path (every definition column is baselined or migration-added) @regression', function () {
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', '..', '..', 'fixtures', 'schema-baseline.json'), 'utf8'));
        const baselineCols   = baseline.baseline || {};
        const knownUnledgered = new Set((baseline.known_unledgered || []).map(s => s.toLowerCase()));

        // Columns any dated migration ADDs, as `table.col` (reuses the proven parser).
        const migrated = new Set(collectMigrationColumns().map(c => (c.table + '.' + c.name).toLowerCase()));
        // Plus every column of a table a dated migration CREATEs outright: those arrive on
        // the ledger path through the CREATE TABLE, not an ADD COLUMN.
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
});

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
    // The guard above exempts a pre-ledger column by NAME alone, and a baseline that
    // stores nothing but names lets a definition-only SHAPE change to a baselined column -
    // widening `balances.amount VARCHAR(250)`, flipping its nullability or default, or moving
    // it among its pre-ledger siblings - stay green with no dated migration behind it. That
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
            path.join(__dirname, '..', '..', '..', 'fixtures', 'schema-baseline.json'), 'utf8'));
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
});

// The guard above enforces only HALF of the remedy its own failure message
// mandates. It fires when baseline != definition, and the mandated fix is "ship a dated
// migration with the matching MODIFY, AND re-freeze this fixture in the SAME commit".
// Only the re-freeze is machine-checked. Doing the re-freeze ALONE restores
// baseline == definition and turns the guard green with no migration behind it, so every
// aged DB and every replay-only replica keeps the old column shape forever
// (alterTableForDrift adds a MISSING column but never retypes an existing one) - the exact
// divergence the shape guard closed, one `git add` away.
//
// Enforcing the other half needs an ANCHOR: "this entry was re-frozen" is not derivable
// from a fixture that has just been rewritten, and nothing else in the tree remembers the
// old shape. test/fixtures/schema-baseline-origin.json is that anchor, sha256-pinned in
// ORIGIN_BASELINE_SHA256 above; any entry whose frozen shape has moved off it must name a
// dated migration whose LAST MODIFY carries the new shape. That is the same convergence
// condition the last-MODIFY-wins case asserts, read from the other end: there a migration
// must match the definition, here a moved definition must have a migration.
//
// The anchor is seeded from the shape-guard landing (01f321c1), NOT from today's baseline, and
// the difference is the whole guard. An anchor copied from today is vacuous: nothing
// differs from it, so this case checks nothing and would first do work on some future
// commit that nobody ever watched it fail on. Seeded from that landing it already carries
// sixteen divergences - the fifteen utf8mb4 column re-freezes and destroys.action_index
// on the index side - so both shipped re-freezes are resolved through their real
// migrations by this case today, and the sanity test below pins that.
//
// Comparison basis is stripInlineKeys on BOTH sides, exactly as the last-MODIFY-wins case
// compares: MariaDB's MODIFY cannot restate a table-level key, so detecting drift on a
// basis no MODIFY can reach would raise failures with no legal remedy.
describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
    it('a re-frozen pre-ledger column is backed by a dated migration that converges aged DBs @regression', function () {
        const origin   = loadPinnedOriginFixture(ORIGIN_BASELINE, ORIGIN_BASELINE_SHA256,
                                                 'test/unit/migration/sql_schema_column_parity.test.js');
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', '..', '..', 'fixtures', 'schema-baseline.json'), 'utf8'));

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
});

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
    // Second half of the re-freeze guard: the case above closes the SHAPE bypass, this one closes the ORDER
    // bypass in the same guard. The shape case asserts baseline order == definition order, so
    // reordering the pre-ledger columns of a table AND re-freezing the fixture in one commit
    // is green, while an aged DB keeps the original order and the two paths stop producing a
    // byte-identical SHOW CREATE TABLE. Anchoring the order kills that. No migration escape
    // hatch is offered here even though MODIFY ... AFTER can reposition a column: a
    // repositioning MODIFY also restates the whole column and is a rewrite of the table, so
    // the deliberate path is a reviewed anchor bump, not an assertion this case tries to
    // second-guess.
    it('the pre-ledger columns have not been re-ordered since the origin anchor @regression', function () {
        const origin   = loadPinnedOriginFixture(ORIGIN_BASELINE, ORIGIN_BASELINE_SHA256,
                                                 'test/unit/migration/sql_schema_column_parity.test.js');
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', '..', '..', 'fixtures', 'schema-baseline.json'), 'utf8'));

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
});

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
    // The anchor is only worth what it differs from. Seeding it from today's baseline would
    // leave both cases above passing over an empty set forever, and a re-anchor that quietly
    // absorbs the current baseline has the same effect - so pin that the anchor still carries
    // the two re-freezes we know shipped, each of which the case above resolves through its
    // real migration (utf8mb4 via 2026-08-19-utf8mb4-user-text-columns.sql and its
    // mode=manual index_memos twin; destroys.action_index in the index sibling).
    it('sanity: the origin anchor still differs from the live baseline (re-freeze guard is not vacuous)', function () {
        const origin   = loadPinnedOriginFixture(ORIGIN_BASELINE, ORIGIN_BASELINE_SHA256,
                                                 'test/unit/migration/sql_schema_column_parity.test.js');
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', '..', '..', 'fixtures', 'schema-baseline.json'), 'utf8'));

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
});

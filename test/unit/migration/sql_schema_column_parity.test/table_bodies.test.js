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
 * Column parity, whole-table half: a table a dated migration CREATEs matches its
 * definition once every later ALTER is composed onto it, is never parked in the
 * pre-ledger baseline, and every definition's ENGINE/CHARSET/COLLATE tail is the
 * fleet default or a declared exemption. Part of the column parity suite; see
 * ../sql_schema_column_parity.test.js.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const {
    collectDefinitionColumns, collectMigrationColumns, collectMigrationCreatedTables,
    composeLedgerColumns, bodyTail, collectDefinitionBodies, collectMigrationModifies,
} = require('./helpers/column_ledger.js');

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

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
    // The guard above had no notion of a migration-created TABLE. Its columns are
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
        const mods       = collectMigrationModifies();
        const mismatches = [];
        for (const t of collectMigrationCreatedTables()) {
            if (!bodies[t.table]) { mismatches.push({ table: t.table, file: t.file, reason: 'no src/sql/' + t.table + '.sql definition declares this table' }); continue; }
            // A migration-created table is not frozen at its CREATE. When it later gains a
            // column, or one of its columns is retyped, the CREATE cannot be edited (db.js
            // enforces migration immutability by checksum), so the shape a replaying replica
            // converges to is CREATE + every LATER dated ALTER, and THAT is what must equal
            // the definition. Compare that composed shape: columns (name + normalized spec,
            // in position) plus the non-column tail (keys + ENGINE), which neither an ADD
            // COLUMN nor a MODIFY can change.
            const laterAdds = adds.filter(a => a.table === t.table && a.file > t.file);
            const laterMods = mods.filter(m => m.table === t.table && m.file > t.file);
            if (laterAdds.length === 0 && laterMods.length === 0) {
                if (bodies[t.table] !== t.body) mismatches.push({ table: t.table, file: t.file, reason: 'CREATE TABLE differs from the definition', definition: bodies[t.table], migration: t.body });
                continue;
            }
            const composed = composeLedgerColumns(t, laterAdds, laterMods);
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
});

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
    // The MODIFY leg of the composition above is only worth what it changes. A composition
    // that stopped applying MODIFYs would compare the CREATE's original spec against a
    // definition a dated migration has legitimately moved, so pin the live instance by name:
    // the leg must still turn one column's spec into the one the migration states.
    it('sanity: the migration-created-table composition applies a later MODIFY', function () {
        const created = collectMigrationCreatedTables().find(t => t.table === 'attestation_responses');
        assert.ok(created, 'the attestation_responses CREATE TABLE migration is no longer parsed');
        const mods = collectMigrationModifies()
            .filter(m => m.table === 'attestation_responses' && m.file > created.file);
        assert.ok(mods.length > 0,
            'no dated migration retypes a column of a migration-created table any more, so the MODIFY leg of ' +
            'composeLedgerColumns is passing over an empty set and proves nothing');

        const composed = composeLedgerColumns(created, [], mods);
        const before   = created.columns.find(c => c.name.toLowerCase() === 'response_payload');
        const after    = composed.find(c => c.name.toLowerCase() === 'response_payload');
        assert.ok(before && after, 'attestation_responses.response_payload is no longer parsed on both sides');
        assert.notStrictEqual(after.spec, before.spec,
            'the composition left the CREATE\'s spec in place, so a dated MODIFY no longer reaches the comparison');
        assert.ok(/CHARACTER SET UTF8MB4\b/.test(after.spec),
            'the composed spec is not the widened one the dated migration states: ' + after.spec);
    });

    it('a migration-created table is NOT parked in the pre-ledger baseline', function () {
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', '..', '..', 'fixtures', 'schema-baseline.json'), 'utf8'));
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
            path.join(__dirname, '..', '..', '..', 'fixtures', 'schema-baseline.json'), 'utf8'));
        const defs = collectDefinitionColumns();
        assert.ok(Object.keys(baseline.baseline || {}).length > 50, 'baseline should cover the bulk of tables');
        for (const table of Object.keys(baseline.baseline || {})) {
            assert.ok(defs[table], 'baseline references unknown table ' + table);
        }
    });
});

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
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
});

describe('SQL schema column parity (definition path vs ledger path) @regression', function () {
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

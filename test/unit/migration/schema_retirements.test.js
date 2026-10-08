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
 * Negative controls for the retired-anchor cases in the column and index
 * parity suites. No anchor entry is retired today, so those cases walk an
 * empty set; this file proves the parser and the audit can say no.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const {
    auditRetiredAnchorEntries, collectMigrationDrops, parseMigrationDrops,
} = require('./helpers/schema_retirements.js');

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');
const key      = (d) => `${d.kind} ${d.table}.${d.name} ifExists=${d.ifExists}`;

// Run the audit over one made-up table t holding column c, which every case retires.
const audit = (drops, extra = {}) => auditRetiredAnchorEntries(Object.assign({
    kind: 'column', origin: { t: [{ name: 'c' }, { name: 'k' }] }, baseline: { t: [{ name: 'k' }] },
    isDeclared: (table, name) => name === 'k', drops, definedTables: new Set(['t']),
}, extra));

describe('schema retirements: migration DROP parser @regression @tier1', function () {
    it('reads column, index and table drops in every clause form the migrations use', function () {
        const got = parseMigrationDrops([
            'ALTER TABLE t ADD INDEX a (x),\n  DROP INDEX IF EXISTS b;',
            'ALTER TABLE `t` DROP COLUMN IF EXISTS c, DROP d -- note',
            ';DROP INDEX IF EXISTS e ON t2; /* gone */ DROP TABLE IF EXISTS u, `v`;',
            'ALTER TABLE t DROP KEY f;',
        ].join('\n'), 'f.sql').map(key);
        assert.deepStrictEqual(got, [
            'index t.b ifExists=true', 'column t.c ifExists=true', 'column t.d ifExists=false',
            'index t2.e ifExists=true', 'table u.null ifExists=true', 'table v.null ifExists=true',
            'index t.f ifExists=false',
        ]);
    });

    it('never reads a primary, foreign or constraint drop, or a quoted one, as a retirement', function () {
        const got = parseMigrationDrops(
            "ALTER TABLE t DROP PRIMARY KEY, DROP FOREIGN KEY fk, DROP CONSTRAINT ck, ADD PRIMARY KEY (a);\n" +
            "SET @s = IF(@n > 0, 'ALTER TABLE t DROP INDEX q', 'SELECT 1');", 'f.sql');
        assert.deepStrictEqual(got, []);
    });

    it('finds the shipped column, index and table drops in the real migrations', function () {
        const got = collectMigrationDrops().map(d => d.file + ' ' + key(d));
        for (const want of [
            '2026-07-15-sweeps-drop-legacy-escrows-column.sql column sweeps.escrows ifExists=true',
            '2026-07-13-balances-drop-redundant-address-id-index.sql index balances.address_id ifExists=true',
            '2026-06-16-drop-orphaned-contract-balances.sql table contract_balances.null ifExists=true',
        ]) assert.ok(got.includes(want), 'the DROP parser no longer sees: ' + want);
    });
});

describe('schema retirements: retired anchor audit @regression @tier1', function () {
    it('flags a retired entry that no dated migration drops', function () {
        assert.deepStrictEqual(audit([]), { missing: ['t.c'], unguarded: [] });
    });

    it('clears a retired entry dropped with IF EXISTS, and flags one dropped bare', function () {
        assert.deepStrictEqual(audit([{ kind: 'column', table: 't', name: 'c', ifExists: true }]),
            { missing: [], unguarded: [] });
        assert.deepStrictEqual(audit([
            { kind: 'column', table: 't', name: 'c', ifExists: true },
            { kind: 'column', table: 't', name: 'c', ifExists: false },
        ]), { missing: [], unguarded: ['t.c'] });
    });

    it('does not let an index drop of the same name clear a retired column', function () {
        assert.deepStrictEqual(audit([{ kind: 'index', table: 't', name: 'c', ifExists: true }]),
            { missing: ['t.c'], unguarded: [] });
    });

    it('counts a whole-table drop only once the table definition is gone', function () {
        const drops = [{ kind: 'table', table: 't', name: null, ifExists: true }];
        assert.deepStrictEqual(audit(drops), { missing: ['t.c'], unguarded: [] });
        assert.deepStrictEqual(audit(drops, { definedTables: new Set() }), { missing: [], unguarded: [] });
    });

    it('ignores an entry still baselined or still declared', function () {
        assert.deepStrictEqual(audit([], { baseline: { t: [{ name: 'c' }] } }), { missing: [], unguarded: [] });
        assert.deepStrictEqual(audit([], { isDeclared: () => true }), { missing: [], unguarded: [] });
    });

    it('walks every entry of the real anchors when nothing is kept', function () {
        for (const [file, kind] of [['schema-baseline-origin.json', 'column'], ['schema-index-baseline-origin.json', 'index']]) {
            const origin = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8')).baseline;
            const size   = Object.values(origin).reduce((n, entries) => n + entries.length, 0);
            const got    = auditRetiredAnchorEntries({
                kind, origin, baseline: {}, isDeclared: () => false, drops: [], definedTables: new Set(),
            });
            assert.ok(size > 0, file + ' is empty');
            assert.strictEqual(got.missing.length, size, file + ': the audit skipped anchor entries');
        }
    });
});

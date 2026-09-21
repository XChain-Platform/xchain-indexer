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
 * Schema migration runner: pure-logic contract tests (no live DB).
 *
 * Covers the gate that decides whether a migration runs unattended at startup:
 * migrationMode() header parsing, and the invariant that every committed migration
 * declares its intent explicitly so a destructive file can never default-silently
 * into the auto-apply path on a validator fleet.
 *
 ********************************************************************/

const { assert, fs, path, Database, modeOf } = require('./migration_runner.test/helpers/migration_fixtures.js');
const crypto = require('crypto');


describe('Database._migrationMode() @regression @tier1', function () {

    it('reads mode=auto from the header tag', function () {
        assert.strictEqual(modeOf('-- xchain:migration mode=auto\nALTER TABLE x ADD COLUMN y INT;'), 'auto');
    });

    it('reads mode=manual from the header tag', function () {
        assert.strictEqual(modeOf('-- xchain:migration mode=manual\nDROP INDEX z ON x;'), 'manual');
    });

    it('defaults to manual when no tag is present (never auto-runs unknown DDL)', function () {
        assert.strictEqual(modeOf('-- just a normal migration comment\nALTER TABLE x ADD COLUMN y INT;'), 'manual');
    });

    it('is case-insensitive and tolerant of spacing', function () {
        assert.strictEqual(modeOf('--   XChain:Migration   mode = AUTO  (additive)\n'), 'auto');
    });

    it('only honors the tag on a comment line, and a non-auto/manual value falls through to manual', function () {
        assert.strictEqual(modeOf('-- xchain:migration mode=yolo\n'), 'manual');
    });

    it('ignores a mode= tag below the first SQL statement (body prose cannot arm auto)', function () {
        // A file whose real header omits the tag (defaults manual), with a spoofed
        // `mode=auto` buried below a real SQL statement in trailing prose or a data
        // literal. The scan is prologue-anchored - it stops at the first non-comment,
        // non-blank line - so a tag past the first statement can never arm the
        // auto-apply path for a destructive migration.
        const body = 'ALTER TABLE events ADD COLUMN note TEXT;\n' +
                     '-- xchain:migration mode=auto (trailing prose)\n' +
                     'DROP TABLE events;\n';
        assert.strictEqual(modeOf(body), 'manual');
    });

    it('reads mode=auto from a tag under a multi-line license banner', function () {
        // The house layout puts the license banner first and the mode tag after it,
        // pushing the tag well past the old 10-line window. The prologue scan reads
        // the whole leading comment run, so a banner-prefixed mode=auto still arms.
        let banner = '';
        for(let i = 0; i < 13; i++) banner += '-- license banner line ' + i + '\n';
        const raw = banner + '\n-- xchain:migration mode=auto\nALTER TABLE x ADD COLUMN y INT;';
        assert.strictEqual(modeOf(raw), 'auto');
    });
});

describe('committed migrations declare intent @regression @tier1', function () {
    const MIG_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations');
    let files = [];
    try { files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')); } catch (e) { /* none */ }

    it('migrations directory is present', function () {
        assert.ok(fs.existsSync(MIG_DIR), 'expected ' + MIG_DIR);
    });

    files.forEach(function (file) {
        it(file + ': carries an explicit `-- xchain:migration mode=auto|manual` tag the runner sees', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            // Match the tag ANYWHERE in the file, then assert the runner's prologue-anchored
            // migrationMode actually resolves it to that declared value. This asserts the runner
            // and the declared intent agree, so a tag the runner cannot see (e.g. below the first
            // SQL statement) fails CI instead of default-landing as `manual` while looking tagged
            // (the dead-tag gap this test exists to catch).
            const anywhere = raw.match(/--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
            assert.ok(anywhere,
                file + ' has no explicit mode tag. Every migration must declare intent so a ' +
                'destructive change can never silently auto-run at startup. Add a first line ' +
                '(or place it anywhere in the leading comment prologue): ' +
                '`-- xchain:migration mode=auto` (additive + idempotent) or `mode=manual` (gated).');
            const declared = anywhere[1].toLowerCase();
            assert.strictEqual(modeOf(raw), declared,
                file + ' declares mode=' + declared + ' but _migrationMode reads it as ' + modeOf(raw) +
                ' - the tag sits where the runner cannot see it (it must be in the leading comment ' +
                'prologue, before the first SQL statement).');
        });
    });

    // The runner applies migrations in `readdirSync(...).sort()` order (src/db.js),
    // so a `YYYY-MM-DD-` filename prefix is what guarantees authorship-order apply.
    // The convention is now enforced with NO exemptions: the three legacy undated
    // files were renamed to their authored dates (paired with a ledger rename heal),
    // and runMigrations throws on any undated filename.
    const DATED_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
    files.forEach(function (file) {
        it(file + ': uses the dated YYYY-MM-DD- filename prefix (ordering convention)', function () {
            assert.ok(DATED_PREFIX.test(file),
                file + ' is not dated. Runner apply order is readdirSync().sort(), so every ' +
                'migration must start with a `YYYY-MM-DD-` prefix to apply in authorship order. ' +
                'Rename it with the authored date (no undated files are allowed).');
        });
    });
});

const MIG_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations');
const ALL_RENAMES = Database.MIGRATION_LEDGER_RENAMES;
// Scoped to the three original undated->dated renames. MIGRATION_LEDGER_RENAMES also
// carries later, unrelated rename pairs (see the v0.17.0 describe block below), so
// this suite must not assume it owns the whole map.
const LEGACY_KEYS = [
    'add_balances_composite_index.sql',
    'add_cross_chain_matches_partial_fill_columns.sql',
    'unique_full_column_index_addresses.sql'
];
const RENAMES = {};
LEGACY_KEYS.forEach(function (k) { RENAMES[k] = ALL_RENAMES[k]; });

describe('legacy migration rename: ledger remap + ordering @regression @tier1', function () {
    it('the three legacy undated names are mapped to dated targets', function () {
        assert.deepStrictEqual(Object.keys(RENAMES).sort(), LEGACY_KEYS.slice().sort());
        Object.values(RENAMES).forEach(function (name) {
            assert.ok(/^\d{4}-\d{2}-\d{2}-/.test(name), name + ' must be dated');
        });
    });

    it('every dated target exists on disk and no old undated file remains', function () {
        Object.entries(RENAMES).forEach(function ([oldName, newName]) {
            assert.ok(fs.existsSync(path.join(MIG_DIR, newName)), 'expected renamed file ' + newName);
            assert.ok(!fs.existsSync(path.join(MIG_DIR, oldName)), oldName + ' should have been renamed away');
        });
    });

    it('planLedgerRenames re-keys an old-name-applied database', function () {
        // A DB migrated before the rename recorded the OLD undated names.
        const applied = ['2026-06-16-drop-orphaned-contract-balances.sql'].concat(Object.keys(RENAMES));
        const ops = Database.planLedgerRenames(applied);
        assert.strictEqual(ops.length, 3, 'all three legacy rows should be re-keyed');
        const byFrom = new Map(ops.map(o => [o.from, o.to]));
        Object.entries(RENAMES).forEach(function ([oldName, newName]) {
            assert.strictEqual(byFrom.get(oldName), newName);
        });
    });
});

describe('verifyTables() fresh-schema migration baseline @regression @tier1', function () {
    const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');
    const MIG_DIR = path.join(SQL_DIR, 'migrations');
    const schemaFiles = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'));
    const migrationFiles = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();

    function makeDb(tableExists) {
        const inserted = [];
        const created = [];
        const conn = {
            async query(sql, params) {
                if (/information_schema\.tables/i.test(sql))
                    return tableExists(params[1]) ? [{ table_name: params[1] }] : [];
                if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return [];
                if (/^INSERT INTO schema_migrations/i.test(sql)) {
                    inserted.push(params);
                    return { affectedRows: 1 };
                }
                throw new Error('unexpected query: ' + sql);
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        db.dbName = 'fresh_indexer';
        db.getConnection = async () => conn;
        db.createTable = async (file) => { created.push(file); };
        db.alterTableForDrift = async () => {};
        db.reconcileTableIndexes = async () => {};
        db.util = { throwError(message) { throw new Error(message); } };
        return { db, inserted, created };
    }

    async function quietly(fn) {
        const realLog = console.log, realWarn = console.warn;
        console.log = console.warn = () => {};
        try { return await fn(); }
        finally { console.log = realLog; console.warn = realWarn; }
    }

    it('records every committed migration when boot schema creates every managed table', async function () {
        const { db, inserted, created } = makeDb(() => false);

        assert.strictEqual(await quietly(() => db.verifyTables()), true);
        assert.deepStrictEqual(created.slice().sort(), schemaFiles.slice().sort());
        assert.deepStrictEqual(inserted.map(row => row[0]), migrationFiles);

        const bridgeFile = '2026-09-12-bridge-tables.sql';
        const bridgeRaw = fs.readFileSync(path.join(MIG_DIR, bridgeFile), 'utf8');
        const bridgeRow = inserted.find(row => row[0] === bridgeFile);
        assert.deepStrictEqual(bridgeRow, [
            bridgeFile,
            crypto.createHash('sha256').update(bridgeRaw).digest('hex'),
            'manual'
        ]);
    });

    it('does not baseline migrations when even one managed table already existed', async function () {
        const { db, inserted, created } = makeDb(table => table !== 'bridge_transfers');

        assert.strictEqual(await quietly(() => db.verifyTables()), true);
        assert.deepStrictEqual(created, ['bridge_transfers.sql']);
        assert.deepStrictEqual(inserted, []);
    });
});

describe('legacy migration rename: ledger remap + ordering @regression @tier1', function () {
    it('planLedgerRenames is a no-op on a fresh database (nothing applied yet)', function () {
        assert.deepStrictEqual(Database.planLedgerRenames([]), []);
    });

    it('planLedgerRenames is a no-op on a database already re-keyed (idempotent)', function () {
        // Rows already recorded under the NEW dated names must not be re-keyed again.
        const applied = Object.values(RENAMES);
        assert.deepStrictEqual(Database.planLedgerRenames(applied), []);
    });

    it('does not re-key a legacy row when its dated target is already present', function () {
        // Mixed state: one row still old, but its target already recorded -> skip that one.
        const applied = [
            'add_balances_composite_index.sql',
            '2026-05-30-balances-composite-index.sql'
        ];
        assert.deepStrictEqual(Database.planLedgerRenames(applied), []);
    });

    it('apply order is now lexical = chronological (renamed files land in date order)', function () {
        let files = [];
        try { files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort(); } catch (e) { /* none */ }
        // Every file is dated, and lexical sort of YYYY-MM-DD- prefixes is chronological.
        const dates = files.map(f => f.slice(0, 10));
        const ascending = dates.slice().sort();
        assert.deepStrictEqual(dates, ascending, 'files must sort in ascending date order');
        // The three renamed files must precede the dated migration that assumes their
        // schema state (2026-07-07-cross-chain-matches-payout-legs.sql).
        const payoutIdx = files.indexOf('2026-07-07-cross-chain-matches-payout-legs.sql');
        Object.values(RENAMES).forEach(function (name) {
            const idx = files.indexOf(name);
            assert.ok(idx >= 0 && idx < payoutIdx, name + ' must sort before the payout-legs migration');
        });
    });
});

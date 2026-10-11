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

describe('fresh schema migration ledger @regression @tier1', registerFreshSchemaMigrationLedgerTests);

const FRESH_LEDGER_INSERT_SQL = /^INSERT INTO schema_migrations \(name, checksum, mode, applied_at\) VALUES \(\?, \?, \?, NOW\(\)\) ON DUPLICATE KEY UPDATE name = name$/;

async function seedFreshSchemaMigrations(options = {}) {
    const calls = [];
    let ensured = false;
    let inserted = 0;
    const connection = {
        async query(sql, params) {
            calls.push({ sql, params });
            if(/GET_LOCK/i.test(sql)) return [{ l: options.lockResult === undefined ? 1 : options.lockResult }];
            if(/^INSERT INTO schema_migrations/i.test(sql)){
                inserted++;
                if(options.failAtInsert === inserted) throw new Error('insert failed');
            }
            return [];
        },
    };
    const db = {
        dbName: 'fake_indexer',
        ensureMigrationsLedger: async function (conn) {
            assert.strictEqual(conn, connection);
            assert.strictEqual(calls.length, 0, 'the ledger DDL must run before the lock and the transaction');
            ensured = true;
        },
        migrationMode: Database.prototype.migrationMode,
        recordFreshSchemaMigrations: Database.prototype.recordFreshSchemaMigrations,
    };
    const realInfo = console.log;
    console.log = () => {};
    try {
        await db.recordFreshSchemaMigrations(connection);
        return { calls, ensured, error: null };
    } catch(error){
        return { calls, ensured, error };
    } finally {
        console.log = realInfo;
    }
}

const indexOfMigrationCall = (calls, re) => calls.findIndex(c => re.test(c.sql));
const lastIndexOfMigrationCall = (calls, re) => calls.map(c => c.sql).findLastIndex(sql => re.test(sql));

async function verifyFreshSchema(existingTable, options = {}) {
    const created = [];
    const order = [];
    let recorded = 0;
    const connection = {
        async query(sql, params) {
            if(/information_schema\.tables/i.test(sql))
                return params[1] === existingTable ? [{}] : [];
            throw new Error('unexpected statement: ' + sql);
        },
        async release() {},
    };
    const db = {
        dbName: 'fake_indexer',
        util: { throwError(message) { throw new Error(message); } },
        getConnection: async () => connection,
        createTable: async file => {
            if(options.failCreateAt === created.length + 1) throw new Error('create failed');
            created.push(file);
            order.push('create');
        },
        alterTableForDrift: async () => {},
        reconcileTableIndexes: async () => {},
        recordFreshSchemaMigrations: async conn => {
            assert.strictEqual(conn, connection);
            recorded++;
            order.push('seed');
        },
        schemaShapeSummary: () => 'Schema shape: test fixture.',
        verifyTables: Database.prototype.verifyTables,
    };
    let error = null;
    try { await db.verifyTables(); } catch(e){ error = e; }
    return { created, recorded, order, error };
}

function registerFreshSchemaLedgerRecordingTest() {
    it('records every committed migration with its checksum, mode and database timestamp', async function () {
        const { calls, ensured, error } = await seedFreshSchemaMigrations();
        assert.strictEqual(error, null);
        const inserts = calls.filter(c => /^INSERT INTO schema_migrations/i.test(c.sql));

        const files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
        assert.ok(ensured, 'the ledger table must exist before fresh-schema rows are recorded');
        assert.strictEqual(inserts.length, files.length);
        assert.deepStrictEqual(inserts.map(i => i.params[0]), files);
        for(const insert of inserts){
            const [file, checksum, mode] = insert.params;
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            assert.strictEqual(checksum, crypto.createHash('sha256').update(raw).digest('hex'));
            assert.strictEqual(mode, modeOf(raw));
            assert.match(insert.sql, FRESH_LEDGER_INSERT_SQL);
            assert.strictEqual(insert.params.length, 3, 'applied_at must come from NOW(), not a JavaScript value');
        }
        assert.ok(inserts.some(i => i.params[0] === '2026-09-12-bridge-tables.sql'),
            'the fresh bridge tables migration must be present in the applied ledger');
    });
}

function registerFreshSchemaLedgerTransactionTests() {
    it('seeds in one transaction under the migration lock, so a kill leaves all rows or none', async function () {
        const { calls, error } = await seedFreshSchemaMigrations();
        assert.strictEqual(error, null);
        const getLock  = indexOfMigrationCall(calls, /GET_LOCK/i);
        const begin    = indexOfMigrationCall(calls, /^START TRANSACTION$/i);
        const first    = indexOfMigrationCall(calls, /^INSERT INTO schema_migrations/i);
        const last     = lastIndexOfMigrationCall(calls, /^INSERT INTO schema_migrations/i);
        const commit   = indexOfMigrationCall(calls, /^COMMIT$/i);
        const release  = indexOfMigrationCall(calls, /RELEASE_LOCK/i);
        assert.deepStrictEqual(calls[getLock].params, ['xchain_migrate_fake_indexer'],
            'the seed must take the same lock name the migration runner takes');
        assert.ok(getLock >= 0 && getLock < begin && begin < first, 'lock, then BEGIN, then the first row');
        assert.ok(last < commit && commit < release, 'last row, then COMMIT, then the lock is released');
        assert.strictEqual(indexOfMigrationCall(calls, /^ROLLBACK$/i), -1);
    });

    it('rolls back, releases the lock and rethrows when a row fails partway', async function () {
        const { calls, error } = await seedFreshSchemaMigrations({ failAtInsert: 3 });
        assert.match(error && error.message, /insert failed/);
        assert.ok(indexOfMigrationCall(calls, /^ROLLBACK$/i) > 0, 'a failed seed must roll back its partial rows');
        assert.strictEqual(indexOfMigrationCall(calls, /^COMMIT$/i), -1, 'a failed seed must never commit a prefix');
        assert.ok(indexOfMigrationCall(calls, /RELEASE_LOCK/i) > indexOfMigrationCall(calls, /^ROLLBACK$/i));
    });

    it('refuses without writing a row when another process holds the lock', async function () {
        const { calls, error } = await seedFreshSchemaMigrations({ lockResult: 0 });
        assert.match(error && error.message, /could not acquire lock xchain_migrate_fake_indexer/);
        assert.strictEqual(indexOfMigrationCall(calls, /^INSERT INTO schema_migrations/i), -1);
        assert.strictEqual(indexOfMigrationCall(calls, /^START TRANSACTION$/i), -1);
    });
}

function registerFreshSchemaVerificationTests() {
    it('seeds the ledger only when no declared table existed (a fresh install)', async function () {
        const sqlFiles = fs.readdirSync(path.join(MIG_DIR, '..'))
            .filter(file => file.endsWith('.sql'));
        const fresh = await verifyFreshSchema(null);
        assert.strictEqual(fresh.error, null);
        assert.strictEqual(fresh.created.length, sqlFiles.length);
        assert.strictEqual(fresh.recorded, 1);

        const aged = await verifyFreshSchema(sqlFiles[0].slice(0, -4));
        assert.strictEqual(aged.created.length, sqlFiles.length - 1);
        assert.strictEqual(aged.recorded, 0);
    });

    it('seeds BEFORE the first table is created, so an interrupted create loop keeps a full ledger', async function () {
        const fresh = await verifyFreshSchema(null);
        assert.strictEqual(fresh.order[0], 'seed');
        assert.strictEqual(fresh.order.filter(step => step === 'seed').length, 1);

        const partial = await verifyFreshSchema(null, { failCreateAt: 3 });
        assert.ok(partial.error, 'a failed CREATE must still surface');
        assert.strictEqual(partial.recorded, 1, 'the ledger was already seeded when the create loop broke');
        assert.strictEqual(partial.created.length, 2);
    });
}

function registerFreshSchemaMigrationLedgerTests() {
    registerFreshSchemaLedgerRecordingTest();
    registerFreshSchemaLedgerTransactionTests();
    registerFreshSchemaVerificationTests();
}

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

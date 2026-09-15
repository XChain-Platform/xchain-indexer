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

const { assert, fs, path, Database, requireWithFreshConfig, DB_PATH, modeOf, BRIDGE_TABLES_PROBE, bridgeTablesPresent } = require('./helpers/migration_fixtures.js');


const crypto  = require('crypto');
const MIG_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const allFiles = () => fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
const ledgerOfAll = () => new Map(allFiles().map(f => [f, sha256(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'))]));

// `DatabaseClass` lets a case that sets env run the runner from a Database loaded
// after the write: the strict-checksum switch is read from src/config.js's
// load-time CONFIG_ENV snapshot, not from process.env at call time.
async function runAgainst(ledger, opts, DatabaseClass = Database) {
const logged = [];
const applied = [];
const conn = {
    query: async function (sql, params) {
        if (/GET_LOCK/i.test(sql))     return [{ l: 1 }];
        if (/RELEASE_LOCK/i.test(sql)) return [{}];
        if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) {
            return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
        }
        if (/^INSERT INTO schema_migrations/i.test(sql.trim())) { applied.push(params[0]); return {}; }
        if (/^(UPDATE|INSERT|CREATE|ALTER|DROP)/i.test(sql.trim())) return {};
        return [];
    },
    release: async function () {},
};
const db = {
    dbName: 'test_indexer',
    transactionConnection: null,
    getConnection: async () => conn,
    ensureMigrationsLedger: async () => {},
    runMigrationsInner: DatabaseClass.prototype.runMigrationsInner,
    migrationMode: DatabaseClass.prototype.migrationMode,
    migrationPreconditionSkip: DatabaseClass.prototype.migrationPreconditionSkip,
    splitSqlStatements: DatabaseClass.prototype.splitSqlStatements,
    stripSqlLineComments: DatabaseClass.prototype.stripSqlLineComments,
    destructiveAutoStatement: DatabaseClass.prototype.destructiveAutoStatement,
    isIdRepairUpdate: DatabaseClass.prototype.isIdRepairUpdate,
};
const realLog = console.log, realErr = console.error, realWarn = console.warn;
console.log = console.error = console.warn = (...a) => { logged.push(a.join(' ')); };
try {
    const r = await DatabaseClass.prototype.runMigrationsInner.call(db, opts || {});
    return { logged, applied, result: r, threw: null };
} catch (err) {
    return { logged, applied, result: null, threw: err };
} finally {
    console.log = realLog; console.error = realErr; console.warn = realWarn;
}
}

// Backdating guard in the apply loop. Apply order is lexical, so a migration committed
// with a date EARLIER than one the fleet already applied runs in its date slot on a
// fresh DB and after the frontier on an aged one, diverging the schemas. Driven through
// the real runMigrationsInner against the real migrations dir: seeding the ledger with
// every file EXCEPT an early auto one reproduces exactly the aged-DB shape.
describe('runMigrations() backdated-migration guard @regression @tier1', function () {
    // Earliest committed mode=auto file: pulling it out of the ledger makes it pending
    // behind a frontier of everything else, which is the backdating shape.
    const EARLY_AUTO = allFiles().find(f =>
        modeOf(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')) === 'auto');
    const EARLY_MANUAL = allFiles().find(f =>
        modeOf(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')) === 'manual');

    it('the shipped tree is clean: a fully current ledger raises no backdating error', async function () {
        const { logged, threw } = await runAgainst(ledgerOfAll(), {});
        assert.strictEqual(threw, null, 'a current ledger must not throw: ' + (threw && threw.message));
        assert.ok(!logged.some(l => /dated BEFORE/.test(l)), 'unexpected backdating log: ' + logged.join(' | '));
    });

    it('the operator path fails closed on a backdated auto migration', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(EARLY_AUTO);
        const { threw } = await runAgainst(ledger, { includeManual: true });
        assert.ok(threw, 'the operator path must refuse a backdated migration, not apply it');
        assert.match(threw.message, /dated BEFORE already-applied migration/);
        assert.ok(threw.message.includes(EARLY_AUTO), 'the error must name the offending file');
    });

    it('opt-in strict mode fails closed on the passive startup path too', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(EARLY_AUTO);
        const prev = process.env.MIGRATION_STRICT_CHECKSUM;
        process.env.MIGRATION_STRICT_CHECKSUM = '1';
        try {
            const { threw } = await runAgainst(ledger, {}, requireWithFreshConfig(DB_PATH));
            assert.ok(threw && /dated BEFORE already-applied migration/.test(threw.message));
        } finally {
            if (prev === undefined) delete process.env.MIGRATION_STRICT_CHECKSUM;
            else process.env.MIGRATION_STRICT_CHECKSUM = prev;
        }
    });

    it('default passive startup logs loudly but still boots (no fleet black-start)', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(EARLY_AUTO);
        const { logged, applied, threw } = await runAgainst(ledger, {});
        assert.strictEqual(threw, null, 'passive startup must not hard-fail the fleet');
        assert.ok(logged.some(l => /dated BEFORE already-applied migration/.test(l)),
            'the divergence must still be reported: ' + logged.join(' | '));
        assert.ok(applied.includes(EARLY_AUTO), 'behavior is unchanged on the passive path: the file still applies');
    });

    // The carve-out that keeps the guard shippable. A mode=manual file legitimately sits
    // unapplied behind the frontier for as long as the operator defers it, so guarding it
    // would make `node src/db/migration/migrate.js` throw on every aged fleet DB.
    it('a deferred mode=manual migration is exempt and still applies on the operator path', async function () {
        const ledger = ledgerOfAll();
        ledger.delete(EARLY_MANUAL);
        const { logged, applied, threw } = await runAgainst(ledger, { includeManual: true });
        assert.strictEqual(threw, null,
            'a deferred manual migration must not be mistaken for a backdated one: ' + (threw && threw.message));
        assert.ok(!logged.some(l => /dated BEFORE/.test(l)), 'manual files must not be flagged: ' + logged.join(' | '));
        assert.ok(applied.includes(EARLY_MANUAL), 'the operator must still be able to apply it');
    });
});

describe('runMigrations() backdated-migration guard @regression @tier1', function () {
    // The aged-fleet shape the frontier filter exists for. A DB migrated between 7f1142e
    // and 1c728c5 carries an undated add_controller_bound_token_columns.sql row that no
    // rename heals, and undated sorts above every 2026-* name. Before the filter this made
    // the frontier garbage and threw on the operator path for an ordinary new migration -
    // the same hard-fail of `node src/db/migration/migrate.js` on an aged fleet DB that the manual
    // carve-out above exists to prevent, reintroduced from the ledger side.
    it('an undated legacy ledger row does not fail the operator path for a normal new migration', async function () {
        const files  = allFiles();
        const newest = files[files.length - 1];          // at the frontier by construction
        const ledger = ledgerOfAll();
        ledger.delete(newest);
        ledger.set('add_controller_bound_token_columns.sql', 'legacy-checksum');
        const { logged, applied, threw } = await runAgainst(ledger, { includeManual: true });
        assert.strictEqual(threw, null,
            'an undated legacy row must not hard-fail an aged fleet DB: ' + (threw && threw.message));
        assert.ok(!logged.some(l => /dated BEFORE/.test(l)), 'unexpected backdating log: ' + logged.join(' | '));
        assert.ok(applied.includes(newest), 'the newest migration must still apply');
    });
});

// Per-file scoping (--file / opts.only), ported from the decoder's runner.
// A fleet rollout of ONE pending manual migration must not drag in the other ten:
// three of them are destructive (drop-legacy-escrows-column, drop-orphaned-contract-
// balances, markets-dedup-unique-pair). Driven against the REAL migrations dir - the
// indexer resolves it from __dirname, so there is no tmp-dir seam to substitute.
    const TARGET = '2026-07-24-pubkeys-widen-uncompressed.sql';

    // Fake conn recording ledger INSERTs and executed migration-body statements.
    // `pubkeyLen` answers the post-run width assertion.
    function makeDb(ledgerRows, pubkeyLen = 130, preRunLen = null) {
        const applied  = [];
        const executed = [];
        const conn = {
            async query(sql, params) {
                if (/GET_LOCK/i.test(sql))                                         return [{ l: '1' }];
                if (/RELEASE_LOCK/i.test(sql))                                     return [];
                if (/CREATE TABLE (IF NOT EXISTS )?schema_migrations/i.test(sql))  return [];
                if (/SELECT name, checksum FROM schema_migrations/i.test(sql))     return ledgerRows.slice();
                // The width is read twice per run and the two reads mean different
                // things: the migration precondition asks BEFORE the file is
                // considered (a column already wide means there is nothing to
                // convert, so the file is baselined rather than run), and the
                // post-run assertion asks after. A test that needs the migration to
                // actually execute reports the pre-migration width until the
                // widening statement has run. The queries are textually identical,
                // so ordering is what separates them.
                if (/information_schema\.columns/i.test(sql)) {
                    const widened = executed.some(s => /ALTER TABLE pubkeys\s+MODIFY pubkey VARCHAR\(130\)/i.test(s));
                    return [{ len: (preRunLen !== null && !widened) ? preRunLen : pubkeyLen }];
                }
                // Bare-ledger harness, live-schema question: see BRIDGE_TABLES_PROBE above.
                if (BRIDGE_TABLES_PROBE.test(sql)) return bridgeTablesPresent();
                if (/^INSERT INTO schema_migrations/i.test(sql.trim())) { applied.push(params[0]); return []; }
                if (/^UPDATE schema_migrations/i.test(sql.trim()))                 return [];
                executed.push(sql);
                return [];
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        db.dbName = 'fake_indexer';
        db.transactionConnection = null;
        db.getConnection = async () => conn;
        db.ensureMigrationsLedger = async () => {};
        return { db, applied, executed };
    }

    // The runner narrates every skip; keep the suite output readable.
    async function quietly(fn) {
        const realLog = console.log, realWarn = console.warn;
        console.log = console.warn = () => {};
        try { return await fn(); }
        finally { console.log = realLog; console.warn = realWarn; }
    }

describe('runMigrations() --file / opts.only scoping @regression @tier1', function () {
    it('applies ONLY the targeted file and leaves every other one pending and untouched', async function () {
        // Start narrow so the target is genuinely outstanding: against an
        // already-wide column the runner correctly baselines it instead, which
        // is a different behaviour with its own coverage.
        const { db, applied, executed } = makeDb([], 130, 66);
        const res = await quietly(() => db.runMigrations({ includeManual: true, only: TARGET }));
        assert.deepStrictEqual(applied, [TARGET], 'only the targeted file is recorded as applied');
        assert.deepStrictEqual(res.applied, [TARGET]);
        assert.ok(executed.some(s => /ALTER TABLE pubkeys\s+MODIFY pubkey VARCHAR\(130\)/i.test(s)),
            'the targeted DDL must run');
        assert.ok(!res.pending.includes(TARGET), 'the applied target is not also pending');
        assert.ok(res.pending.includes('2026-07-15-markets-dedup-unique-pair.sql'),
            'untargeted pending work is still reported to the operator');
        // The three destructive manual files are exactly what a blanket run would drag in.
        assert.ok(!executed.some(s => /DROP COLUMN|DROP TABLE|DELETE FROM/i.test(s)),
            'a scoped run must execute no untargeted destructive DDL: ' + executed.join(' | '));
    });
});

describe('runMigrations() --file / opts.only scoping @regression @tier1', function () {
    it('accepts an array of targets', async function () {
        const { db, applied } = makeDb([]);
        const second = '2026-07-10-contract-state-bin-key-index.sql';
        const res = await quietly(() => db.runMigrations({ includeManual: true, only: [TARGET, second] }));
        assert.deepStrictEqual(applied.slice().sort(), [TARGET, second].sort());
        assert.ok(!res.pending.includes(TARGET) && !res.pending.includes(second));
    });

    it('is idempotent: re-targeting an already-applied file applies nothing', async function () {
        const dir = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');
        const sum = require('crypto').createHash('sha256')
            .update(fs.readFileSync(path.join(dir, TARGET), 'utf8')).digest('hex');
        const { db, applied, executed } = makeDb([{ name: TARGET, checksum: sum }]);
        const res = await quietly(() => db.runMigrations({ includeManual: true, only: TARGET }));
        assert.deepStrictEqual(applied, [], 'nothing re-applied (target already recorded)');
        assert.deepStrictEqual(res.applied, []);
        assert.deepStrictEqual(executed, [], 'no DDL at all on a no-op scoped run');
    });

    it('fails loudly on an unknown target (typo protection), applying nothing', async function () {
        const { db, applied } = makeDb([]);
        await assert.rejects(
            () => quietly(() => db.runMigrations({ includeManual: true, only: 'nope-not-a-file.sql' })),
            /target\(s\) not found/);
        assert.deepStrictEqual(applied, [], 'silently applying nothing would look like a successful no-op run');
    });

    it('throws when opts.only is an empty array (guards a mis-wired caller)', async function () {
        const { db } = makeDb([]);
        await assert.rejects(
            () => quietly(() => db.runMigrations({ includeManual: true, only: [] })), /empty/);
    });

    it('a blanket run (no opts.only) still walks the whole tree', async function () {
        const { db, applied } = makeDb([]);
        await quietly(() => db.runMigrations({ includeManual: true }));
        assert.ok(applied.length > 1 && applied.includes(TARGET),
            'the default path must remain apply-everything');
    });
});

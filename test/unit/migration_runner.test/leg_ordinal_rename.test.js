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

const { assert, fs, path, Database, BRIDGE_TABLES_PROBE, bridgeTablesPresent } = require('./helpers/migration_fixtures.js');


// The leg-ordinal migration was authored in the same commit as the two v0.17.0
// renames above but was itself left sorting before an already-applied migration
// (2026-09-11-cross-chain-btc-chain-id.sql), so every fleet boot logged the
// backdating warning and applied it out of its dated position. Same shape and same
// remedy: renamed forward past everything currently in the tree, healed with a
// MIGRATION_LEDGER_RENAMES entry for the databases that already recorded it applied
// under the old name.
const MIG_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations');
const crypto  = require('crypto');
const sha256  = (s) => crypto.createHash('sha256').update(s).digest('hex');

const OLD_NAME = '2026-09-09-destroys-sends-leg-ordinal.sql';
const NEW_NAME = '2026-09-13-destroys-sends-leg-ordinal.sql';
const FRONTIER = '2026-09-11-cross-chain-btc-chain-id.sql';
// Full end-to-end: a ledger holding the OLD name (the rolled-fleet shape from the
// ledger entry) re-keys in place and reports zero pending, no re-apply, no
// "review manually" divergence line. Without the map entry this reports the file
// pending and re-runs its (already-applied) ADD COLUMN, and reports a boot warning.
async function runAgainst(ledger) {
    const updates = [];
    const logged  = [];
    const conn = {
        query: async function (sql, params) {
            if (/GET_LOCK/i.test(sql))     return [{ l: 1 }];
            if (/RELEASE_LOCK/i.test(sql)) return [{}];
            if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) {
                return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
            }
            if (BRIDGE_TABLES_PROBE.test(sql)) return bridgeTablesPresent();
            if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return {};
            if (/^(UPDATE|INSERT|CREATE|ALTER|DROP)/i.test(sql.trim())) { updates.push({ sql, params }); return {}; }
            return [];
        },
        release: async function () {},
    };
    const db = {
        dbName: 'test_indexer',
        transactionConnection: null,
        getConnection: async () => conn,
        ensureMigrationsLedger: Database.prototype.ensureMigrationsLedger,
        runMigrationsInner: Database.prototype.runMigrationsInner,
        assertPubkeyColumnIsUncompressedWide: Database.prototype.assertPubkeyColumnIsUncompressedWide,
        assertStakeWeightOrderingCollation: Database.prototype.assertStakeWeightOrderingCollation,
        migrationMode: Database.prototype.migrationMode,
        migrationPreconditionSkip: Database.prototype.migrationPreconditionSkip,
        splitSqlStatements: Database.prototype.splitSqlStatements,
        stripSqlLineComments: Database.prototype.stripSqlLineComments,
        destructiveAutoStatement: Database.prototype.destructiveAutoStatement,
        isIdRepairUpdate: Database.prototype.isIdRepairUpdate,
    };
    const realLog = console.log, realErr = console.error, realWarn = console.warn;
    console.log = console.error = console.warn = (...a) => { logged.push(a.join(' ')); };
    try {
        const result = await Database.prototype.runMigrations.call(db, {});
        return { updates, logged, result };
    } finally {
        console.log = realLog; console.error = realErr; console.warn = realWarn;
    }
}

describe('leg-ordinal migration rename: destroys-sends-leg-ordinal @regression @tier1', function () {
    it('the old name is registered in MIGRATION_LEDGER_RENAMES and maps to the new name', function () {
        assert.strictEqual(Database.MIGRATION_LEDGER_RENAMES[OLD_NAME], NEW_NAME,
            OLD_NAME + ' must map to ' + NEW_NAME + ' in MIGRATION_LEDGER_RENAMES');
    });

    it('the new dated file exists on disk and the old name is gone', function () {
        assert.ok(fs.existsSync(path.join(MIG_DIR, NEW_NAME)), 'expected renamed file ' + NEW_NAME);
        assert.ok(!fs.existsSync(path.join(MIG_DIR, OLD_NAME)), OLD_NAME + ' should have been renamed away');
    });

    it('planLedgerRenames re-keys a ledger carrying the OLD name', function () {
        const applied = [FRONTIER, OLD_NAME];
        const ops = Database.planLedgerRenames(applied);
        const byFrom = new Map(ops.map(o => [o.from, o.to]));
        assert.strictEqual(byFrom.get(OLD_NAME), NEW_NAME);
    });

    it('reproduces the reported defect: the OLD name sorts before the frontier it was applied after', function () {
        assert.strictEqual(Database.backdatedFrontierViolation(OLD_NAME, [FRONTIER]), FRONTIER,
            'this is the exact shape that produced the boot warning before the rename');
    });

    it('the renamed file no longer sorts before the frontier it was applied after', function () {
        assert.strictEqual(Database.backdatedFrontierViolation(NEW_NAME, [FRONTIER]), null);
    });

    it('the renamed file sorts after every migration currently in the tree', function () {
        const files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql') && f !== NEW_NAME);
        assert.strictEqual(Database.backdatedFrontierViolation(NEW_NAME, files), null,
            NEW_NAME + ' must not backdate against any migration shipped today');
    });
});

describe('leg-ordinal migration rename: destroys-sends-leg-ordinal @regression @tier1', function () {
    it('a ledger carrying the OLD name re-keys to the new one, reports zero pending and logs no warning', async function () {
        const ledger = new Map();
        for (const f of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))) {
            const raw = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
            const key = (f === NEW_NAME) ? OLD_NAME : f;
            ledger.set(key, sha256(raw));
        }

        const { updates, logged, result } = await runAgainst(ledger);

        assert.ok(!result.pending.includes(NEW_NAME), NEW_NAME + ' must not be reported pending: ' + JSON.stringify(result.pending));
        assert.ok(!result.applied.includes(NEW_NAME), NEW_NAME + ' must not be re-applied: ' + JSON.stringify(result.applied));
        assert.ok(!logged.some(l => /review manually/i.test(l)), 'unexpected review-manually line: ' + logged.join(' | '));
        assert.ok(!logged.some(l => /dated BEFORE/i.test(l)), 'unexpected backdating log (this is the defect the rename fixes): ' + logged.join(' | '));

        const renamedTo = new Set(updates.filter(u => /SET name/i.test(u.sql)).map(u => u.params[0]));
        assert.ok(renamedTo.has(NEW_NAME), NEW_NAME + ' should have been re-keyed in the ledger: ' + JSON.stringify([...renamedTo]));
    });

    // Second-boot shape: the SAME database boots again after the re-key already
    // landed (the UPDATE ran on the previous boot, so the ledger now carries the
    // NEW name outright, same as every other already-applied file). Must stay
    // silent forever after the one-time heal, never re-warn or re-apply.
    it('a database already re-keyed to the new name boots silently on every later boot', async function () {
        const ledger = new Map();
        for (const f of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))) {
            ledger.set(f, sha256(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')));
        }

        const { updates, logged, result } = await runAgainst(ledger);

        assert.ok(!result.pending.includes(NEW_NAME));
        assert.ok(!result.applied.includes(NEW_NAME));
        assert.ok(!logged.some(l => /dated BEFORE/i.test(l)), 'a healed database must never re-warn: ' + logged.join(' | '));
        assert.strictEqual(updates.filter(u => /SET name/i.test(u.sql) && u.params[1] === OLD_NAME).length, 0,
            'a database with no OLD-name row left must not re-key again');
    });

    // Fresh-build shape: a brand-new database has never seen either name. It must
    // apply the file once, under its new dated name, with no warning.
    it('a fresh database applies the file once under the new name with no warning', async function () {
        const { updates, logged, result } = await runAgainst(new Map());

        assert.ok(result.applied.includes(NEW_NAME), 'fresh install must apply the renamed file: ' + JSON.stringify(result.applied));
        assert.ok(!logged.some(l => /dated BEFORE/i.test(l)), 'a fresh database must never see the backdating warning: ' + logged.join(' | '));
        const inserted = new Set(updates.filter(u => /^INSERT INTO schema_migrations/i.test(u.sql)).map(u => u.params[0]));
        assert.ok(inserted.has(NEW_NAME), NEW_NAME + ' must be recorded applied on a fresh build');
        assert.strictEqual(inserted.size, result.applied.length + result.baselined.length,
            'every applied or baselined file, and only those, is recorded in the ledger');
    });
});


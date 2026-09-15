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


// the v0.17.0 regtest-first rehearsal found two more migrations that sorted
// before an already-applied one (2026-09-08-deploy-deferred-assembly.sql) and were
// renamed forward from 2026-09-08- to 2026-09-11-. Unlike the three legacy renames
// above (never applied under their old names on any live fleet DB before this repo's
// rename landed), the fleet HAD already recorded these two as applied under their OLD
// 2026-09-08- names before the rename shipped, so the re-key map entries are the only
// thing standing between a rolled database and re-applying an ADD COLUMN that is
// already there.
const MIG_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');
const crypto  = require('crypto');
const sha256  = (s) => crypto.createHash('sha256').update(s).digest('hex');

const OLD_NAMES = [
    '2026-09-08-contract-meta-columns.sql',
    '2026-09-08-cross-chain-btc-chain-id.sql',
];
const NEW_NAMES = [
    '2026-09-11-contract-meta-columns.sql',
    '2026-09-11-cross-chain-btc-chain-id.sql',
];

// Full end-to-end: a ledger holding the OLD names (exactly the shape every rolled
// fleet/regtest indexer database recorded before this rename map entry existed)
// must re-key in place and report BOTH files as already applied - zero pending,
// no re-apply, no "review manually" divergence line. Without the map entries this
// reports both files pending and re-runs their (already-applied) ADD COLUMN.
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
            // Bare-ledger harness, live-schema question: see BRIDGE_TABLES_PROBE above.
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

describe('v0.17.0 migration rename: contract-meta-columns + cross-chain-btc-chain-id @regression @tier1', function () {
    it('both old-to-new filename pairs are registered in MIGRATION_LEDGER_RENAMES', function () {
        OLD_NAMES.forEach(function (oldName, i) {
            assert.strictEqual(Database.MIGRATION_LEDGER_RENAMES[oldName], NEW_NAMES[i],
                oldName + ' must map to ' + NEW_NAMES[i] + ' in MIGRATION_LEDGER_RENAMES');
        });
    });

    it('both dated targets exist on disk and neither old name remains', function () {
        NEW_NAMES.forEach(function (name) {
            assert.ok(fs.existsSync(path.join(MIG_DIR, name)), 'expected renamed file ' + name);
        });
        OLD_NAMES.forEach(function (name) {
            assert.ok(!fs.existsSync(path.join(MIG_DIR, name)), name + ' should have been renamed away');
        });
    });

    it('planLedgerRenames re-keys a ledger carrying the OLD v0.17.0 names', function () {
        const applied = ['2026-09-08-deploy-deferred-assembly.sql'].concat(OLD_NAMES);
        const ops = Database.planLedgerRenames(applied);
        const byFrom = new Map(ops.map(o => [o.from, o.to]));
        OLD_NAMES.forEach(function (oldName, i) {
            assert.strictEqual(byFrom.get(oldName), NEW_NAMES[i],
                'expected ' + oldName + ' to re-key to ' + NEW_NAMES[i]);
        });
    });

    it('both renamed files still sort after 2026-09-08-deploy-deferred-assembly.sql', function () {
        assert.strictEqual(Database.backdatedFrontierViolation(
            '2026-09-11-contract-meta-columns.sql', ['2026-09-08-deploy-deferred-assembly.sql']), null);
        assert.strictEqual(Database.backdatedFrontierViolation(
            '2026-09-11-cross-chain-btc-chain-id.sql', ['2026-09-08-deploy-deferred-assembly.sql']), null);
    });
});

describe('v0.17.0 migration rename: contract-meta-columns + cross-chain-btc-chain-id @regression @tier1', function () {
    it('a ledger carrying the OLD names re-keys to the new ones and reports zero pending', async function () {
        // Every migration on disk, applied under its CURRENT name, except the two under
        // test which are seeded under their OLD (pre-rename) recorded names - exactly
        // the rolled-fleet shape from the ledger entry.
        const ledger = new Map();
        for (const f of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))) {
            const raw = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
            const idx = NEW_NAMES.indexOf(f);
            const key = idx === -1 ? f : OLD_NAMES[idx];
            ledger.set(key, sha256(raw));
        }

        const { updates, logged, result } = await runAgainst(ledger);

        NEW_NAMES.forEach(function (name) {
            assert.ok(!result.pending.includes(name), name + ' must not be reported pending: ' + JSON.stringify(result.pending));
            assert.ok(!result.applied.includes(name), name + ' must not be re-applied: ' + JSON.stringify(result.applied));
        });
        assert.ok(!logged.some(l => /review manually/i.test(l)), 'unexpected review-manually line: ' + logged.join(' | '));
        assert.ok(!logged.some(l => /dated BEFORE/i.test(l)), 'unexpected backdating log: ' + logged.join(' | '));

        const renamedTo = new Set(updates.filter(u => /SET name/i.test(u.sql)).map(u => u.params[0]));
        NEW_NAMES.forEach(function (name) {
            assert.ok(renamedTo.has(name), name + ' should have been re-keyed in the ledger: ' + JSON.stringify([...renamedTo]));
        });
    });
});

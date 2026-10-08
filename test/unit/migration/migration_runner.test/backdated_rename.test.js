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
 **********************************************************************/

const crypto = require('crypto');
const { assert, fs, path, Database, BRIDGE_TABLES_PROBE, bridgeTablesPresent,
        LIST_SHARE_TABLES_PROBE, listShareTablesPresent } = require('./helpers/migration_fixtures.js');

const MIG_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');
const sha256 = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const RENAMES = {
    '2026-09-12-state-tree-roots-block-index-idx.sql': '2026-10-08-state-tree-roots-block-index-idx.sql',
    '2026-09-12-token-bridge-fields.sql':              '2026-10-08-token-bridge-fields.sql',
};
const FRONTIER = '2026-10-07-ledger-covering-index.sql';

async function runAgainst(ledger) {
    const updates = [];
    const logged = [];
    const conn = {
        query: async function (sql, params) {
            if (/GET_LOCK/i.test(sql)) return [{ l: 1 }];
            if (/RELEASE_LOCK/i.test(sql)) return [{}];
            if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) {
                return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
            }
            if (BRIDGE_TABLES_PROBE.test(sql)) return bridgeTablesPresent();
            if (LIST_SHARE_TABLES_PROBE.test(sql)) return listShareTablesPresent();
            if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return {};
            if (/^(UPDATE|INSERT|CREATE|ALTER|DROP)/i.test(sql.trim())) {
                updates.push({ sql, params });
                return {};
            }
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
    const realLog = console.log;
    const realErr = console.error;
    const realWarn = console.warn;
    console.log = console.error = console.warn = (...args) => { logged.push(args.join(' ')); };
    try {
        const result = await Database.prototype.runMigrations.call(db, {});
        return { updates, logged, result };
    } finally {
        console.log = realLog;
        console.error = realErr;
        console.warn = realWarn;
    }
}

describe('backdated testnet migration renames @regression @tier1', function () {
    it('registers both old-to-new filename pairs', function () {
        for (const [oldName, newName] of Object.entries(RENAMES)) {
            assert.strictEqual(Database.MIGRATION_LEDGER_RENAMES[oldName], newName);
        }
    });

    it('ships both new files and removes both old filenames', function () {
        for (const [oldName, newName] of Object.entries(RENAMES)) {
            assert.ok(!fs.existsSync(path.join(MIG_DIR, oldName)), oldName + ' must be absent');
            assert.ok(fs.existsSync(path.join(MIG_DIR, newName)), newName + ' must exist');
        }
    });

    it('preserves each applied migration checksum across the rename', function () {
        const pins = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', '..', '..', 'fixtures', 'migration-executable-residue.json'), 'utf8'));
        for (const newName of Object.values(RENAMES)) {
            const raw = fs.readFileSync(path.join(MIG_DIR, newName), 'utf8');
            assert.strictEqual(sha256(raw), pins[newName].sha256);
        }
    });

    it('moves both migrations after the frontier they were applied behind', function () {
        for (const [oldName, newName] of Object.entries(RENAMES)) {
            assert.strictEqual(Database.backdatedFrontierViolation(oldName, [FRONTIER]), FRONTIER);
            assert.strictEqual(Database.backdatedFrontierViolation(newName, [FRONTIER]), null);
        }
    });

    it('plans both ledger re-keys without re-keying an already healed ledger', function () {
        const oldNames = Object.keys(RENAMES);
        const ops = Database.planLedgerRenames([FRONTIER].concat(oldNames));
        assert.deepStrictEqual(new Map(ops.map(op => [op.from, op.to])), new Map(Object.entries(RENAMES)));
        assert.deepStrictEqual(Database.planLedgerRenames(Object.values(RENAMES)), []);
    });
});

describe('backdated testnet migration renames @regression @tier1', function () {
    it('re-keys a rolled ledger and neither warns nor re-applies either migration', async function () {
        const ledger = new Map();
        const reverse = new Map(Object.entries(RENAMES).map(([oldName, newName]) => [newName, oldName]));
        for (const file of fs.readdirSync(MIG_DIR).filter(name => name.endsWith('.sql'))) {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            ledger.set(reverse.get(file) || file, sha256(raw));
        }

        const { updates, logged, result } = await runAgainst(ledger);

        for (const newName of Object.values(RENAMES)) {
            assert.ok(!result.pending.includes(newName), newName + ' must not remain pending');
            assert.ok(!result.applied.includes(newName), newName + ' must not be re-applied');
        }
        assert.ok(!logged.some(line => /review manually|dated BEFORE/i.test(line)), logged.join(' | '));
        const renamedTo = new Set(updates.filter(call => /SET name/i.test(call.sql)).map(call => call.params[0]));
        assert.deepStrictEqual(renamedTo, new Set(Object.values(RENAMES)));
    });
});

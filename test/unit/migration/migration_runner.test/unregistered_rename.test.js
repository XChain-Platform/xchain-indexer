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
 * Schema migration runner: a pending file whose bytes match a ledger row with no file.
 *
 * The ledger is keyed by filename, so an applied migration renamed without a
 * MIGRATION_LEDGER_RENAMES entry looks pending under its new name. The runner must
 * refuse it on the operator path and leave it unapplied on passive startup.
 *
 ********************************************************************/

const crypto = require('crypto');
const { assert, fs, path, Database, SQL_MODE_PROBE, pinnedSqlModeRows, BRIDGE_TABLES_PROBE,
        bridgeTablesPresent, LIST_SHARE_TABLES_PROBE, listShareTablesPresent } = require('./helpers/migration_fixtures.js');

const MIG_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');
const TARGET = '2026-10-06-resolved-block-idx.sql';
const OLD_NAME = '2026-10-05-resolved-block-idx.sql';
const sha256 = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// A ledger recording every committed file, with TARGET moved under `targetName` and `targetSum`.
function ledgerWith(targetName, targetSum) {
    const ledger = new Map();
    for (const file of fs.readdirSync(MIG_DIR).filter((name) => name.endsWith('.sql'))) {
        const sum = sha256(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
        ledger.set(file === TARGET ? targetName : file, file === TARGET ? (targetSum || sum) : sum);
    }
    return ledger;
}

function fakeConn(ledger, writes) {
    return {
        query: async function (sql, params) {
            if (SQL_MODE_PROBE.test(sql)) return pinnedSqlModeRows();
            if (/GET_LOCK/i.test(sql)) return [{ l: 1 }];
            if (/RELEASE_LOCK/i.test(sql)) return [{}];
            if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) {
                return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
            }
            if (BRIDGE_TABLES_PROBE.test(sql)) return bridgeTablesPresent();
            if (LIST_SHARE_TABLES_PROBE.test(sql)) return listShareTablesPresent();
            if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return {};
            if (/^(UPDATE|INSERT|CREATE|ALTER|DROP)/i.test(sql.trim())) writes.push({ sql, params });
            return [];
        },
        release: async function () {},
    };
}

async function runAgainst(ledger, opts) {
    const writes = [];
    const logged = [];
    const conn = fakeConn(ledger, writes);
    const db = Object.create(Database.prototype);
    Object.assign(db, { dbName: 'test_indexer', transactionConnection: null, getConnection: async () => conn });
    const saved = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...args) => { logged.push(args.join(' ')); };
    try {
        const result = await Database.prototype.runMigrations.call(db, opts);
        return { writes, logged, result };
    } finally {
        [console.log, console.error, console.warn] = saved;
    }
}

const recorded = (writes, file) => writes.some((w) => /INSERT INTO schema_migrations/i.test(w.sql) && w.params[0] === file);

describe('Database.runMigrations() unregistered rename guard @regression @tier1', function () {
    it('leaves a renamed applied file unapplied on passive startup and logs the missing entry', async function () {
        const { writes, logged, result } = await runAgainst(ledgerWith(OLD_NAME), {});
        assert.strictEqual(result.applied.includes(TARGET), false, TARGET + ' must not run a second time');
        assert.strictEqual(recorded(writes, TARGET), false);
        assert.deepStrictEqual(result.unregisteredRenames, [{ file: TARGET, ledgerName: OLD_NAME }]);
        assert.ok(logged.some((line) => line.includes('same content as ledger row ' + OLD_NAME)), logged.join(' | '));
    });

    it('refuses the renamed file on the operator path, naming the registry entry to add', async function () {
        await assert.rejects(runAgainst(ledgerWith(OLD_NAME), { includeManual: true }),
            new RegExp('Add the entry "' + OLD_NAME + '": "' + TARGET + '"'));
    });

    it('applies the file when no ledger row carries its bytes', async function () {
        const { writes, result } = await runAgainst(ledgerWith(OLD_NAME, 'f'.repeat(64)), {});
        assert.ok(result.applied.includes(TARGET), 'a genuinely new file still applies');
        assert.strictEqual(recorded(writes, TARGET), true);
        assert.deepStrictEqual(result.unregisteredRenames, []);
    });

    it('lists ledger names with no file, sorted', function () {
        assert.deepStrictEqual(Database.orphanedLedgerNames(['b.sql', 'a.sql', 'c.sql'], ['b.sql']), ['a.sql', 'c.sql']);
        assert.deepStrictEqual(Database.orphanedLedgerNames(new Map([['a.sql', 'h']]).keys(), ['a.sql']), []);
    });
});

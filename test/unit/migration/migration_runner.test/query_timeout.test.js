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
 ********************************************************************/

const crypto = require('crypto');
const {
    assert, fs, path, Database, requireWithFreshConfig, DB_PATH,
} = require('./helpers/migration_fixtures.js');

const MIG_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');

function shippedMigrations(){
    return fs.readdirSync(MIG_DIR).filter(file => file.endsWith('.sql')).sort();
}

const PENDING_MIGRATION = '2026-09-27-datetime-state-tree-roots.sql';

function ledgerMissingLast(){
    const files = shippedMigrations();
    const ledger = new Map(files.map(file => [
        file,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(MIG_DIR, file), 'utf8')).digest('hex'),
    ]));
    // The pending migration these cases drive is named, not taken as the newest file:
    // its SET time_zone opener and ALTER TABLE state_tree_roots body are what the
    // assertions locate, so a later migration landing must not change which one runs.
    assert.ok(ledger.has(PENDING_MIGRATION), PENDING_MIGRATION + ' is not a shipped migration');
    ledger.delete(PENDING_MIGRATION);
    return ledger;
}

async function runAgainst(DatabaseClass = Database, options = {}){
    const calls = [];
    const lifecycle = { destroyed: 0, released: 0 };
    const conn = {
        async query(sql, params){
            calls.push({ sql, params });
            if(/GET_LOCK/i.test(sql)) return [{ l: options.lockResult === undefined ? 1 : options.lockResult }];
            if(/RELEASE_LOCK/i.test(sql)) return [{}];
            if(/SELECT name, checksum FROM schema_migrations/i.test(sql)){
                const ledger = options.ledger || ledgerMissingLast();
                return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
            }
            if(options.throwMigration && /^ALTER TABLE state_tree_roots/i.test(sql.trim())){
                throw new Error('migration failed');
            }
            if(options.throwRestore && /^SET SESSION max_statement_time/i.test(sql) && params[0] === 30){
                throw new Error('restore failed');
            }
            return [];
        },
        async destroy(){ lifecycle.destroyed++; },
        async release(){ lifecycle.released++; },
    };
    const db = Object.create(DatabaseClass.prototype);
    db.dbName = 'test_indexer';
    db.connectionPoolParams = { queryTimeout: 30000 };
    db.getConnection = async () => conn;
    db.ensureMigrationsLedger = async () => {};
    const realLog = console.log, realError = console.error, realWarn = console.warn;
    console.log = console.error = console.warn = () => {};
    try {
        const runOptions = { includeManual: true, ...options.runOptions };
        const result = await DatabaseClass.prototype.runMigrationsInner.call(db, runOptions);
        return { calls, lifecycle, result, error: null };
    } catch(error){
        return { calls, lifecycle, result: null, error };
    } finally {
        console.log = realLog; console.error = realError; console.warn = realWarn;
    }
}

function statementTimeCalls(calls){
    return calls.filter(call => /^SET SESSION max_statement_time/i.test(call.sql));
}

describe('migration-scoped query timeout @regression @tier1', function () {
    it('uses one hour during migration and restores the runtime timeout before unlocking', async function () {
        const previous = process.env.MIGRATE_QUERY_TIMEOUT;
        delete process.env.MIGRATE_QUERY_TIMEOUT;
        try {
            const FreshDatabase = requireWithFreshConfig(DB_PATH);
            const { calls, error } = await runAgainst(FreshDatabase);
            assert.strictEqual(error, null);
            const getLock = calls.findIndex(call => /GET_LOCK/i.test(call.sql));
            const migrationTimeout = calls.findIndex(call => statementTimeCalls([call])[0]?.params[0] === 3600);
            const firstMigration = calls.findIndex(call => /^SET time_zone/i.test(call.sql.trim()));
            const lastMigration = calls.map(call => call.sql).findLastIndex(sql => /^ALTER TABLE state_tree_roots/i.test(sql.trim()));
            const restore = calls.findIndex(call => statementTimeCalls([call])[0]?.params[0] === 30);
            const releaseLock = calls.findIndex(call => /RELEASE_LOCK/i.test(call.sql));
            assert.strictEqual(migrationTimeout, getLock + 1);
            assert.ok(migrationTimeout < firstMigration);
            assert.ok(lastMigration < restore && restore < releaseLock);
        } finally {
            if(previous === undefined) delete process.env.MIGRATE_QUERY_TIMEOUT;
            else process.env.MIGRATE_QUERY_TIMEOUT = previous;
        }
    });

    for(const [raw, seconds] of [['0', 0], ['900000', 900]]){
        it('uses MIGRATE_QUERY_TIMEOUT=' + raw + ' and still restores 30 seconds', async function () {
            const previous = process.env.MIGRATE_QUERY_TIMEOUT;
            process.env.MIGRATE_QUERY_TIMEOUT = raw;
            try {
                const FreshDatabase = requireWithFreshConfig(DB_PATH);
                const { calls, error } = await runAgainst(FreshDatabase);
                assert.strictEqual(error, null);
                assert.deepStrictEqual(statementTimeCalls(calls).map(call => call.params[0]), [seconds, 30]);
            } finally {
                if(previous === undefined) delete process.env.MIGRATE_QUERY_TIMEOUT;
                else process.env.MIGRATE_QUERY_TIMEOUT = previous;
            }
        });
    }
});

describe('migration-scoped query timeout cleanup @regression @tier1', function () {
    it('restores the runtime timeout before unlocking after a migration error', async function () {
        const { calls, error } = await runAgainst(Database, { throwMigration: true });
        assert.match(error && error.message, /migration failed/);
        const failedMigration = calls.findIndex(call => /^ALTER TABLE state_tree_roots/i.test(call.sql.trim()));
        const restore = calls.findIndex(call => statementTimeCalls([call])[0]?.params[0] === 30);
        const releaseLock = calls.findIndex(call => /RELEASE_LOCK/i.test(call.sql));
        assert.ok(failedMigration < restore && restore < releaseLock);
    });

    it('does not change max_statement_time when the migration lock is unavailable', async function () {
        const { calls, result, error } = await runAgainst(Database, { lockResult: 0 });
        assert.strictEqual(error, null);
        assert.strictEqual(result.lockSkipped, true);
        assert.deepStrictEqual(statementTimeCalls(calls), []);
    });

    it('sets and restores max_statement_time before checking for pending migrations', async function () {
        const ledger = ledgerMissingLast();
        const last = shippedMigrations().at(-1);
        ledger.set(last, crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(MIG_DIR, last), 'utf8')).digest('hex'));
        const { calls, error } = await runAgainst(Database, { ledger });
        assert.strictEqual(error, null);
        assert.deepStrictEqual(statementTimeCalls(calls).map(call => call.params[0]), [3600, 30]);
        const getLock = calls.findIndex(call => /GET_LOCK/i.test(call.sql));
        const migrationTimeout = calls.findIndex(call => statementTimeCalls([call])[0]?.params[0] === 3600);
        const ledgerRead = calls.findIndex(call => /SELECT name, checksum FROM schema_migrations/i.test(call.sql));
        assert.strictEqual(migrationTimeout, getLock + 1);
        assert.ok(migrationTimeout < ledgerRead);
    });

    it('does not change max_statement_time for a scoped no-op run', async function () {
        const ledger = ledgerMissingLast();
        const last = shippedMigrations().at(-1);
        ledger.set(last, crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(MIG_DIR, last), 'utf8')).digest('hex'));
        const { calls, error } = await runAgainst(Database, {
            ledger,
            runOptions: { only: last },
        });
        assert.strictEqual(error, null);
        assert.deepStrictEqual(statementTimeCalls(calls), []);
    });

    it('destroys rather than releases a connection whose runtime timeout cannot be restored', async function () {
        const { calls, lifecycle, error } = await runAgainst(Database, { throwRestore: true });
        assert.strictEqual(error, null);
        assert.strictEqual(lifecycle.destroyed, 1);
        assert.strictEqual(lifecycle.released, 0);
        const restore = calls.findIndex(call => statementTimeCalls([call])[0]?.params[0] === 30);
        const releaseLock = calls.findIndex(call => /RELEASE_LOCK/i.test(call.sql));
        assert.ok(restore < releaseLock);
    });
});

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

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sinon = require('sinon');

const DB_PATH = require.resolve('../../../src/db');
const DOTENV_PATH = require.resolve('dotenv');
const MIGRATE_PATH = require.resolve('../../../src/db/migration/migrate.js');
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/sql/migrations');
const { requireWithFreshConfig } = require('../../helpers/fresh_config.js');

const ENV_KEYS = ['INDEXER_DB_HOST', 'INDEXER_DB_PORT', 'INDEXER_DB_NAME',
    'INDEXER_DB_USER', 'INDEXER_DB_PASS', 'INDEXER_COIN', 'INDEXER_NETWORK'];
const cli = {};

function migrationFiles() {
    return fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
}

function setUpCase() {
    cli.savedEnv = {};
    for (const key of ENV_KEYS) {
        cli.savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    cli.savedArgv = process.argv;
    cli.savedExitCode = process.exitCode;
    process.argv = ['node', 'migrate.js'];
    process.exitCode = undefined;
    process.env.INDEXER_DB_HOST = 'db.test';
    process.env.INDEXER_DB_NAME = 'indexer_test';
    process.env.INDEXER_DB_USER = 'tester';
    process.env.INDEXER_COIN = 'BTC';
    process.env.INDEXER_NETWORK = 'regtest';
    cli.exitStub = sinon.stub(process, 'exit');
    cli.errorStub = sinon.stub(console, 'error');
    cli.logStub = sinon.stub(console, 'log');
}

function tearDownCase() {
    sinon.restore();
    process.argv = cli.savedArgv;
    process.exitCode = cli.savedExitCode;
    for (const key of ENV_KEYS) {
        if (cli.savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = cli.savedEnv[key];
    }
    delete require.cache[MIGRATE_PATH];
    delete require.cache[DB_PATH];
    delete require.cache[DOTENV_PATH];
}

// The real rename planner, bound to the real rename map before the fake replaces the class.
const realPlanLedgerRenames = require('../../../src/db').planLedgerRenames;
const RENAMED_FROM = '2026-09-08-contract-meta-columns.sql';
const RENAMED_TO = '2026-09-11-contract-meta-columns.sql';

function makeFakeDb({ queryError, ledgerRows, planner = () => [] } = {}) {
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const files = migrationFiles();
    const state = {
        constructed: 0,
        poolEnded: false,
        released: false,
        queries: [],
        done,
        files,
        runMigrations: sinon.spy(async () => ({ applied: [], pending: [] })),
    };
    class FakeDatabase {
        constructor() {
            state.constructed++;
            this.pool = { end: async () => { state.poolEnded = true; resolveDone(); } };
            this.runMigrations = state.runMigrations;
        }
        async getConnection() {
            return {
                query: async (sql) => {
                    state.queries.push(sql);
                    if (queryError) throw queryError;
                    if (ledgerRows) return ledgerRows;
                    return files.slice(0, -2).map((name) => ({
                        name, mode: 'auto', applied_at: '2026-09-27T00:00:00.000Z'
                    }));
                },
                release: async () => { state.released = true; },
            };
        }
        migrationMode() { return 'manual'; }
        static planLedgerRenames(names) { return planner(names); }
    }
    state.FakeDatabase = FakeDatabase;
    return state;
}

function loadMigrate(fakeDbClass, args) {
    process.argv = ['node', 'migrate.js', ...args];
    delete require.cache[MIGRATE_PATH];
    require.cache[DB_PATH] = {
        id: DB_PATH, filename: DB_PATH, loaded: true, exports: fakeDbClass
    };
    require.cache[DOTENV_PATH] = {
        id: DOTENV_PATH, filename: DOTENV_PATH, loaded: true,
        exports: { config: () => ({ parsed: {} }) }
    };
    requireWithFreshConfig(MIGRATE_PATH, { keep: [DB_PATH] });
}

function printed(stub) {
    return stub.getCalls().map((call) => call.args.join(' ')).join('\n');
}

describe('migrate CLI status report @regression', function () {
    beforeEach(setUpCase);
    afterEach(tearDownCase);

    it('--status --json reports the ledger without applying migrations', async function () {
        const fake = makeFakeDb();
        loadMigrate(fake.FakeDatabase, ['--status', '--json']);
        await fake.done;

        const output = printed(cli.logStub);
        const report = JSON.parse(output.slice(output.indexOf('{')));
        assert.deepStrictEqual(Object.keys(report),
            ['database', 'total', 'applied', 'pending', 'migrations']);
        assert.strictEqual(report.database, 'indexer_test');
        assert.strictEqual(report.total, fake.files.length);
        assert.strictEqual(report.applied, fake.files.length - 2);
        assert.strictEqual(report.pending, 2);
        assert.strictEqual(cli.logStub.callCount, 1, 'JSON mode must print one report object');
        assert.deepStrictEqual(report.migrations.map(Object.keys),
            fake.files.map(() => ['file', 'applied', 'mode', 'appliedAt']));
        const applied = fake.files.slice(0, -2).map((file) => ({
            file, applied: true, mode: 'auto', appliedAt: '2026-09-27T00:00:00.000Z'
        }));
        const pending = fake.files.slice(-2).map((file) => ({
            file, applied: false, mode: 'manual', appliedAt: null
        }));
        assert.deepStrictEqual(report.migrations, [...applied, ...pending]);
        assert.deepStrictEqual(fake.queries,
            ['SELECT name, mode, applied_at FROM schema_migrations']);
        assert.strictEqual(fake.runMigrations.called, false);
        assert.strictEqual(cli.exitStub.called, false);
        assert.strictEqual(process.exitCode, undefined);
        assert.strictEqual(fake.released, true);
        assert.strictEqual(fake.poolEnded, true);
    });

    it('reports every migration pending when the ledger table does not exist', async function () {
        const missingTable = Object.assign(new Error('missing ledger'), { errno: 1146 });
        const fake = makeFakeDb({ queryError: missingTable });
        loadMigrate(fake.FakeDatabase, ['--status', '--json']);
        await fake.done;

        const output = printed(cli.logStub);
        const report = JSON.parse(output.slice(output.indexOf('{')));
        assert.strictEqual(report.applied, 0);
        assert.strictEqual(report.pending, fake.files.length);
        assert.ok(report.migrations.every((row) => !row.applied && row.mode === 'manual'));
        assert.strictEqual(fake.runMigrations.called, false);
        assert.strictEqual(cli.exitStub.called, false);
        assert.strictEqual(process.exitCode, undefined);
        assert.strictEqual(fake.released, true);
        assert.strictEqual(fake.poolEnded, true);
    });

    it('sets exitCode 1 and closes the pool when the ledger query fails', async function () {
        const fake = makeFakeDb({ queryError: new Error('query failed') });
        loadMigrate(fake.FakeDatabase, ['--status', '--json']);
        await fake.done;

        assert.strictEqual(cli.logStub.called, false, 'a failed query must print no report');
        assert.strictEqual(fake.runMigrations.called, false);
        assert.strictEqual(cli.exitStub.called, false);
        assert.strictEqual(process.exitCode, 1);
        assert.match(printed(cli.errorStub), /STATUS FAILED: Error: query failed/);
        assert.strictEqual(fake.released, true);
        assert.strictEqual(fake.poolEnded, true);
    });

    it('--status prints only the text report and its summary', async function () {
        const fake = makeFakeDb();
        loadMigrate(fake.FakeDatabase, ['--status']);
        await fake.done;

        const output = printed(cli.logStub);
        assert.match(output, new RegExp(
            'migrate: ' + fake.files.length + ' migration\\(s\\), ' +
            (fake.files.length - 2) + ' applied, 2 pending\\.$'
        ));
        assert.strictEqual(output.split('\n').some((line) => line.startsWith('{')), false);
        assert.strictEqual(fake.runMigrations.called, false);
        assert.strictEqual(process.exitCode, undefined);
        assert.strictEqual(fake.poolEnded, true);
    });

    it('reports a renamed file applied when the ledger still holds its old name', async function () {
        const files = migrationFiles();
        assert.ok(files.includes(RENAMED_TO), RENAMED_TO + ' must be on disk');
        const ledgerRows = files.filter((name) => name !== RENAMED_TO)
            .map((name) => ({ name, mode: 'auto', applied_at: '2026-09-27T00:00:00.000Z' }))
            .concat([{ name: RENAMED_FROM, mode: 'auto', applied_at: '2026-09-09T00:00:00.000Z' }]);
        const fake = makeFakeDb({ ledgerRows, planner: realPlanLedgerRenames });
        loadMigrate(fake.FakeDatabase, ['--status', '--json']);
        await fake.done;

        const output = printed(cli.logStub);
        const report = JSON.parse(output.slice(output.indexOf('{')));
        assert.deepStrictEqual(report.migrations.find((row) => row.file === RENAMED_TO),
            { file: RENAMED_TO, applied: true, mode: 'auto', appliedAt: '2026-09-09T00:00:00.000Z' });
        assert.strictEqual(report.migrations.some((row) => row.file === RENAMED_FROM), false);
        assert.strictEqual(report.pending, 0);
        assert.strictEqual(report.applied, files.length);
        // Status stays read-only: the one ledger SELECT, no UPDATE, no runner.
        assert.deepStrictEqual(fake.queries,
            ['SELECT name, mode, applied_at FROM schema_migrations']);
        assert.strictEqual(fake.runMigrations.called, false);
        assert.strictEqual(process.exitCode, undefined);
    });

    it('keeps the new name\'s own row when the ledger holds both old and new names', async function () {
        const files = migrationFiles();
        const ledgerRows = files.map((name) => ({ name, mode: 'auto', applied_at: '2026-09-27T00:00:00.000Z' }))
            .concat([{ name: RENAMED_FROM, mode: 'manual', applied_at: '2026-09-09T00:00:00.000Z' }]);
        const fake = makeFakeDb({ ledgerRows, planner: realPlanLedgerRenames });
        loadMigrate(fake.FakeDatabase, ['--status', '--json']);
        await fake.done;

        const output = printed(cli.logStub);
        const report = JSON.parse(output.slice(output.indexOf('{')));
        assert.deepStrictEqual(report.migrations.find((row) => row.file === RENAMED_TO),
            { file: RENAMED_TO, applied: true, mode: 'auto', appliedAt: '2026-09-27T00:00:00.000Z' });
        assert.strictEqual(report.pending, 0);
    });

    it('refuses unsafe status argument combinations before constructing a Database', function () {
        const cases = [
            ['--dry-run'],
            ['--status', '--dry-run'],
            ['--json'],
            ['--status', '--file', 'x.sql'],
            ['x.sql'],
        ];
        for (const args of cases) {
            const fake = makeFakeDb();
            loadMigrate(fake.FakeDatabase, args);
            assert.strictEqual(cli.exitStub.calledOnceWithExactly(2), true, args.join(' '));
            assert.strictEqual(fake.constructed, 0, args.join(' '));
            assert.strictEqual(fake.runMigrations.called, false, args.join(' '));
            assert.strictEqual(fake.poolEnded, false, args.join(' '));
            cli.exitStub.resetHistory();
        }
    });
});

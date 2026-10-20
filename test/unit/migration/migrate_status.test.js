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
const crypto = require('crypto');
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

// The checksum the runner records for a committed file, so a fake ledger row matches it.
function sumOf(name) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')).digest('hex');
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
                        name, checksum: sumOf(name), mode: 'auto', applied_at: '2026-09-27T00:00:00.000Z'
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

function registerStatusOutputTests() {
    it('--status --json reports the ledger without applying migrations', async function () {
        const fake = makeFakeDb();
        loadMigrate(fake.FakeDatabase, ['--status', '--json']);
        await fake.done;

        const output = printed(cli.logStub);
        const report = JSON.parse(output.slice(output.indexOf('{')));
        assert.deepStrictEqual(Object.keys(report),
            ['database', 'total', 'applied', 'pending', 'changed', 'migrations', 'orphaned']);
        assert.deepStrictEqual(report.orphaned, []);
        assert.strictEqual(report.database, 'indexer_test');
        assert.strictEqual(report.total, fake.files.length);
        assert.strictEqual(report.applied, fake.files.length - 2);
        assert.strictEqual(report.pending, 2);
        assert.strictEqual(cli.logStub.callCount, 1, 'JSON mode must print one report object');
        assert.deepStrictEqual(report.migrations.map(Object.keys),
            fake.files.map(() => ['file', 'applied', 'mode', 'appliedAt', 'changed']));
        const applied = fake.files.slice(0, -2).map((file) => ({
            file, applied: true, mode: 'auto', appliedAt: '2026-09-27T00:00:00.000Z', changed: false
        }));
        const pending = fake.files.slice(-2).map((file) => ({
            file, applied: false, mode: 'manual', appliedAt: null, changed: false
        }));
        assert.deepStrictEqual(report.migrations, [...applied, ...pending]);
        assert.deepStrictEqual(fake.queries,
            ['SELECT name, checksum, mode, applied_at FROM schema_migrations']);
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
}

function registerStatusFailureAndTextTests() {
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
            (fake.files.length - 2) + ' applied, 2 pending, 0 changed\\.$'
        ));
        assert.strictEqual(output.split('\n').some((line) => line.startsWith('{')), false);
        assert.strictEqual(fake.runMigrations.called, false);
        assert.strictEqual(process.exitCode, undefined);
        assert.strictEqual(fake.poolEnded, true);
    });
}

function registerRenameStatusTests() {
    it('reports a renamed file applied when the ledger still holds its old name', async function () {
        const files = migrationFiles();
        assert.ok(files.includes(RENAMED_TO), RENAMED_TO + ' must be on disk');
        const ledgerRows = files.filter((name) => name !== RENAMED_TO)
            .map((name) => ({ name, checksum: sumOf(name), mode: 'auto', applied_at: '2026-09-27T00:00:00.000Z' }))
            .concat([{ name: RENAMED_FROM, checksum: sumOf(RENAMED_TO), mode: 'auto', applied_at: '2026-09-09T00:00:00.000Z' }]);
        const fake = makeFakeDb({ ledgerRows, planner: realPlanLedgerRenames });
        loadMigrate(fake.FakeDatabase, ['--status', '--json']);
        await fake.done;

        const output = printed(cli.logStub);
        const report = JSON.parse(output.slice(output.indexOf('{')));
        assert.deepStrictEqual(report.migrations.find((row) => row.file === RENAMED_TO),
            { file: RENAMED_TO, applied: true, mode: 'auto', appliedAt: '2026-09-09T00:00:00.000Z', changed: false });
        assert.strictEqual(report.migrations.some((row) => row.file === RENAMED_FROM), false);
        assert.strictEqual(report.pending, 0);
        assert.strictEqual(report.applied, files.length);
        // Status stays read-only: the one ledger SELECT, no UPDATE, no runner.
        assert.deepStrictEqual(fake.queries,
            ['SELECT name, checksum, mode, applied_at FROM schema_migrations']);
        assert.strictEqual(fake.runMigrations.called, false);
        assert.strictEqual(process.exitCode, undefined);
    });

    it('keeps the new name\'s own row when the ledger holds both old and new names', async function () {
        const files = migrationFiles();
        const ledgerRows = files.map((name) => ({ name, checksum: sumOf(name), mode: 'auto', applied_at: '2026-09-27T00:00:00.000Z' }))
            .concat([{ name: RENAMED_FROM, mode: 'manual', applied_at: '2026-09-09T00:00:00.000Z' }]);
        const fake = makeFakeDb({ ledgerRows, planner: realPlanLedgerRenames });
        loadMigrate(fake.FakeDatabase, ['--status', '--json']);
        await fake.done;

        const output = printed(cli.logStub);
        const report = JSON.parse(output.slice(output.indexOf('{')));
        assert.deepStrictEqual(report.migrations.find((row) => row.file === RENAMED_TO),
            { file: RENAMED_TO, applied: true, mode: 'auto', appliedAt: '2026-09-27T00:00:00.000Z', changed: false });
        assert.strictEqual(report.pending, 0);
    });
}

// A ledger holding every committed file except `target`, which sits under an unregistered old
// name with its bytes' checksum, beside a deleted file's row and a registered rename's old row.
const UNREGISTERED_OLD = '2026-01-01-renamed-without-registry.sql';
function orphanLedger(target) {
    return migrationFiles().filter((name) => name !== target)
        .map((name) => ({ name, checksum: sumOf(name), mode: 'auto', applied_at: 'x' }))
        .concat([
            { name: UNREGISTERED_OLD, checksum: sumOf(target), mode: 'auto', applied_at: 'y' },
            { name: 'add_controller_bound_token_columns.sql', checksum: '0'.repeat(64), mode: 'manual', applied_at: 'z' },
            { name: RENAMED_FROM, checksum: sumOf(RENAMED_TO), mode: 'auto', applied_at: 'w' },
        ]);
}

function registerOrphanStatusTests() {
    it('--status --json lists ledger rows with no file and names a rename missing its registry entry', async function () {
        const target = migrationFiles().slice(-1)[0];
        const fake = makeFakeDb({ ledgerRows: orphanLedger(target), planner: realPlanLedgerRenames });
        loadMigrate(fake.FakeDatabase, ['--status', '--json']);
        await fake.done;

        const output = printed(cli.logStub);
        const report = JSON.parse(output.slice(output.indexOf('{')));
        assert.deepStrictEqual(report.orphaned, [
            { name: UNREGISTERED_OLD, mode: 'auto', appliedAt: 'y', renamedTo: null, sameContentAs: target },
            { name: RENAMED_FROM, mode: 'auto', appliedAt: 'w', renamedTo: RENAMED_TO, sameContentAs: null },
            { name: 'add_controller_bound_token_columns.sql', mode: 'manual', appliedAt: 'z', renamedTo: null, sameContentAs: null },
        ]);
        assert.strictEqual(report.total, report.migrations.length, 'orphans never enter the migrations rows');
        assert.strictEqual(report.pending, 1);
        assert.strictEqual(process.exitCode, undefined);
    });

    it('--status prints an ORPHANED line per ledger row with no file and the refusal note', async function () {
        const target = migrationFiles().slice(-1)[0];
        const fake = makeFakeDb({ ledgerRows: orphanLedger(target), planner: realPlanLedgerRenames });
        loadMigrate(fake.FakeDatabase, ['--status']);
        await fake.done;

        const output = printed(cli.logStub);
        assert.match(output, new RegExp('\\[ORPHANED, mode=auto\\] ' + UNREGISTERED_OLD +
            ' \\(same content as pending ' + target + ': a rename missing its MIGRATION_LEDGER_RENAMES entry\\)'));
        assert.match(output, /\[ORPHANED, mode=manual\] add_controller_bound_token_columns\.sql \(ledger row with no migration file\)/);
        assert.match(output, /will refuse until each renamed file has a MIGRATION_LEDGER_RENAMES entry/);
    });
}

function registerStatusArgumentTests() {
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
}

const REBASED = '2026-06-16-drop-orphaned-contract-balances.sql';
const { MIGRATION_CHECKSUM_REBASELINES } = require('../../../src/db/migration/checksum_rebaselines.js');
const { classifyAppliedChecksum } = require('../../../src/db/migration/checksum_verdict.js');

// Run `--status [--json]` over a full ledger whose rows `edit` may rewrite; returns the output.
async function statusOver(args, edit) {
    const ledgerRows = migrationFiles().map((name) => edit({ name, checksum: sumOf(name), mode: 'auto', applied_at: 'x' }));
    const fake = makeFakeDb({ ledgerRows });
    loadMigrate(fake.FakeDatabase, args);
    await fake.done;
    return { fake, output: printed(cli.logStub) };
}

function registerChangedStatusTests() {
    it('reports an applied file whose content changed as CHANGED and still exits 0', async function () {
        const target = migrationFiles()[0];
        const { fake, output } = await statusOver(['--status', '--json'],
            (r) => (r.name === target ? Object.assign(r, { checksum: '0'.repeat(64) }) : r));
        const report = JSON.parse(output.slice(output.indexOf('{')));
        assert.strictEqual(report.changed, 1);
        assert.deepStrictEqual(report.migrations.filter((m) => m.changed).map((m) => [m.file, m.applied]), [[target, true]]);
        assert.strictEqual(process.exitCode, undefined);
        assert.strictEqual(fake.runMigrations.called, false);
        assert.ok(fake.queries.every((q) => /^SELECT /.test(q)), 'status issues no UPDATE');
    });

    it('prints a CHANGED text line with both hash prefixes and the refusal note', async function () {
        const target = migrationFiles()[0];
        const { output } = await statusOver(['--status'],
            (r) => (r.name === target ? Object.assign(r, { checksum: 'f'.repeat(64) }) : r));
        assert.match(output, new RegExp('\\[CHANGED, mode=auto\\] ' + target + ' \\(recorded ffffffffffff, current ' + sumOf(target).slice(0, 12) + '\\)'));
        assert.match(output, /1 changed\.\nmigrate: a blanket `npm run migrate` will refuse/);
    });

    it('reports a reviewed rebaseline predecessor as applied, not CHANGED', async function () {
        const rebase = MIGRATION_CHECKSUM_REBASELINES[REBASED];
        assert.strictEqual(sumOf(REBASED), rebase.to, REBASED + ' hashes to its pinned rebaseline target');
        const { output } = await statusOver(['--status', '--json'],
            (r) => (r.name === REBASED ? Object.assign(r, { checksum: [].concat(rebase.from)[0] }) : r));
        const report = JSON.parse(output.slice(output.indexOf('{')));
        assert.strictEqual(report.changed, 0);
        assert.strictEqual(report.migrations.find((m) => m.file === REBASED).changed, false);
    });

    it('classifies match, rebaseline and changed exactly as the runner does', function () {
        const table = { 'a.sql': { from: ['1', '2'], to: '3' } };
        assert.strictEqual(classifyAppliedChecksum('a.sql', '3', '3', table), 'match');
        assert.strictEqual(classifyAppliedChecksum('a.sql', '2', '3', table), 'rebaseline');
        assert.strictEqual(classifyAppliedChecksum('a.sql', '9', '3', table), 'changed');
        assert.strictEqual(classifyAppliedChecksum('a.sql', '1', '4', table), 'changed');
        assert.strictEqual(classifyAppliedChecksum('b.sql', null, '3', table), 'changed');
    });
}

describe('migrate CLI status report @regression', function () {
    beforeEach(setUpCase);
    afterEach(tearDownCase);
    registerStatusOutputTests();
    registerStatusFailureAndTextTests();
    registerRenameStatusTests();
    registerOrphanStatusTests();
    registerStatusArgumentTests();
    registerChangedStatusTests();
});

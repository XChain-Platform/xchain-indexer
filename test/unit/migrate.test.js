// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Unit coverage for src/migrate.js: the operator migration CLI that also
// applies pending `manual` migrations. It self-executes on run and connects
// to the indexer DB, so it is exercised as a child process. The safety guard
// under test needs no database: when the INDEXER_DB_* environment is not
// loaded the CLI must refuse to run, exiting non-zero with a clear message
// rather than silently proceeding against an unconfigured target. The child
// runs with a clean environment and a temp cwd so no repo .env is picked up.

const assert = require('assert');
const os = require('os');
const path = require('path');
const sinon = require('sinon');
const { execFileSync } = require('child_process');

const MIGRATE = path.join(__dirname, '..', '..', 'src', 'migrate.js');

const DB_PATH      = require.resolve('../../src/db.js');
const MIGRATE_PATH = require.resolve('../../src/migrate.js');
const DOTENV_PATH  = require.resolve('dotenv');

// Run migrate.js with the DB environment deliberately absent. cwd is a temp
// dir so dotenv.config() finds no .env, and env carries only PATH.
function runWithoutDbEnv() {
    try {
        const stdout = execFileSync(process.execPath, [MIGRATE], {
            cwd: os.tmpdir(),
            env: { PATH: process.env.PATH },
            stdio: 'pipe',
        });
        return { status: 0, stdout: stdout.toString(), stderr: '' };
    } catch (e) {
        return { status: e.status, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() };
    }
}

describe('migrate CLI safety guard', function () {
    it('exits with code 2 when the INDEXER_DB_* environment is not loaded', function () {
        const res = runWithoutDbEnv();
        assert.strictEqual(res.status, 2, 'unconfigured runs must fail fast, not connect');
    });

    it('names the required environment variables in the failure message', function () {
        const res = runWithoutDbEnv();
        const msg = res.stderr + res.stdout;
        assert.match(msg, /INDEXER_DB_HOST/);
        assert.match(msg, /INDEXER_DB_NAME/);
        assert.match(msg, /INDEXER_DB_USER/);
    });

    it('does not print the "applying pending migrations" banner when it bails out', function () {
        const res = runWithoutDbEnv();
        assert.ok(!/applying pending migrations/.test(res.stdout), 'must bail before touching the DB');
    });
});

// Per-file targeting (#3874). migrate.js runs main() at require time, so each case
// injects a fake Database into the require cache, fresh-requires the CLI, and awaits
// a deferred that the fake's pool.end() resolves. Mirrors the decoder's CLI suite,
// which is where this flag shipped first.
describe('migrate CLI --file targeting @regression', function () {

    const ENV_KEYS = ['INDEXER_DB_HOST', 'INDEXER_DB_PORT', 'INDEXER_DB_NAME',
                      'INDEXER_DB_USER', 'INDEXER_DB_PASS'];

    let savedEnv, savedExitCode, savedArgv, exitStub, consoleErrStub, consoleLogStub;

    beforeEach(function () {
        savedEnv = {};
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
        savedExitCode = process.exitCode;
        // Pin a clean argv baseline so the CLI's --file parser sees no stray flags
        // from the mocha invocation; each case appends its own targeting args.
        savedArgv = process.argv;
        process.argv = ['node', 'migrate.js'];
        process.env.INDEXER_DB_HOST = 'db.test';
        process.env.INDEXER_DB_NAME = 'indexer_test';
        process.env.INDEXER_DB_USER = 'tester';
        exitStub       = sinon.stub(process, 'exit');
        consoleErrStub = sinon.stub(console, 'error');
        consoleLogStub = sinon.stub(console, 'log');
    });

    afterEach(function () {
        sinon.restore();
        process.exitCode = savedExitCode;
        process.argv = savedArgv;
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        delete require.cache[MIGRATE_PATH];
        delete require.cache[DB_PATH];
        delete require.cache[DOTENV_PATH];
    });

    // `done` resolves when pool.end() runs (the CLI's finally block), which is the
    // end of main() on every path.
    function makeFakeDb() {
        let resolveDone;
        const done = new Promise((res) => { resolveDone = res; });
        const state = { runArgs: null, poolEnded: false, done };
        class FakeDatabase {
            constructor() {
                this.pool = { end: async () => { state.poolEnded = true; resolveDone(); } };
            }
            async runMigrations(opts) { state.runArgs = opts; return { applied: [], pending: [] }; }
        }
        state.FakeDatabase = FakeDatabase;
        return state;
    }

    function loadMigrateWith(fakeDbClass) {
        delete require.cache[MIGRATE_PATH];
        require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: fakeDbClass };
        // Neutralize migrate.js's require-time dotenv.config(): a checkout .env would
        // repopulate the INDEXER_DB_* vars these cases pin.
        require.cache[DOTENV_PATH] = {
            id: DOTENV_PATH, filename: DOTENV_PATH, loaded: true,
            exports: { config: () => ({ parsed: {} }) }
        };
        require(MIGRATE_PATH);
    }

    it('--file scopes the run to the named migration (passes opts.only)', async function () {
        process.argv = ['node', 'migrate.js', '--file', '2026-07-24-pubkeys-widen-uncompressed.sql'];
        const fake = makeFakeDb();
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.strictEqual(exitStub.called, false);
        assert.deepStrictEqual(fake.runArgs, {
            includeManual: true,
            only: ['2026-07-24-pubkeys-widen-uncompressed.sql']
        }, 'the CLI must scope the run while keeping manual apply armed');
        assert.match(consoleLogStub.getCalls().map(c => c.args[0]).join('\n'),
            /applying ONLY targeted migration\(s\)/);
    });

    it('--file=NAME and repeated flags accumulate (comma-separated too)', async function () {
        process.argv = ['node', 'migrate.js', '--file=a.sql,b.sql', '--file', 'c.sql', '-f', 'd.sql'];
        const fake = makeFakeDb();
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.deepStrictEqual(fake.runArgs, {
            includeManual: true,
            only: ['a.sql', 'b.sql', 'c.sql', 'd.sql']
        });
    });

    it('--file with no value exits 2 before building a DB handle', async function () {
        process.argv = ['node', 'migrate.js', '--file'];
        const fake = makeFakeDb();
        // process.exit is stubbed, so main() continues past the guard; assert the
        // exit(2) signal and the actionable error fired before any migration ran.
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.strictEqual(exitStub.calledWith(2), true, 'expected process.exit(2) on a valueless --file');
        assert.match(consoleErrStub.getCalls().map(c => c.args[0]).join('\n'),
            /--file requires a migration filename argument/);
    });

    it('a default run (no --file) still applies everything with includeManual only', async function () {
        const fake = makeFakeDb();
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.deepStrictEqual(fake.runArgs, { includeManual: true },
            'a blanket run must NOT set opts.only');
    });
});

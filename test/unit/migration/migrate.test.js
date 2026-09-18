// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Unit coverage for src/db/migration/migrate.js: the operator migration CLI that
// also applies pending `manual` migrations. It self-executes on run and connects
// to the indexer DB, so it is exercised as a child process. The safety guard
// under test needs no database: when the INDEXER_DB_* environment is not
// loaded the CLI must refuse to run, exiting non-zero with a clear message
// rather than silently proceeding against an unconfigured target. The child
// runs with a clean environment and a temp cwd so no repo .env is picked up.

const assert = require('assert');
const os = require('os');
const sinon = require('sinon');
const { execFileSync } = require('child_process');

const DB_PATH      = require.resolve('../../../src/db');
const MIGRATE_PATH = require.resolve('../../../src/db/migration/migrate.js');
const DOTENV_PATH  = require.resolve('dotenv');
const { requireWithFreshConfig } = require('../../helpers/fresh_config.js');

// Run migrate.js with the DB environment deliberately absent. cwd is a temp
// dir so dotenv.config() finds no .env, and env carries only PATH.
function runWithoutDbEnv(...args) {
    try {
        const stdout = execFileSync(process.execPath, [MIGRATE_PATH, ...args], {
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

// Per-file targeting. migrate.js runs main() at require time, so each case
// injects a fake Database into the require cache, fresh-requires the CLI, and awaits
// a deferred that the fake's pool.end() resolves. Mirrors the decoder's CLI suite,
// which is where this flag shipped first. The cases run in two sibling describe
// blocks of the same title, each installing the shared hooks below.

// INDEXER_COIN / INDEXER_NETWORK join the DB vars because config.getConfig() loads
// src/coins/<COIN>.js and throws without them; that throw rejects main() and the
// cases below time out rather than fail. Pinned here so this file runs on its own.
const ENV_KEYS = ['INDEXER_DB_HOST', 'INDEXER_DB_PORT', 'INDEXER_DB_NAME',
                  'INDEXER_DB_USER', 'INDEXER_DB_PASS',
                  'INDEXER_COIN', 'INDEXER_NETWORK'];

// Per-case state: what the hooks saved, and the stubs the cases assert on.
const cli = {};

function setUpTargetingCase() {
    cli.savedEnv = {};
    for (const k of ENV_KEYS) { cli.savedEnv[k] = process.env[k]; delete process.env[k]; }
    cli.savedExitCode = process.exitCode;
    // Pin a clean argv baseline so the CLI's --file parser sees no stray flags
    // from the mocha invocation; each case appends its own targeting args.
    cli.savedArgv = process.argv;
    process.argv = ['node', 'migrate.js'];
    process.env.INDEXER_DB_HOST = 'db.test';
    process.env.INDEXER_DB_NAME = 'indexer_test';
    process.env.INDEXER_DB_USER = 'tester';
    process.env.INDEXER_COIN = 'BTC';
    process.env.INDEXER_NETWORK = 'regtest';
    cli.exitStub       = sinon.stub(process, 'exit');
    cli.consoleErrStub = sinon.stub(console, 'error');
    cli.consoleLogStub = sinon.stub(console, 'log');
}

function tearDownTargetingCase() {
    sinon.restore();
    process.exitCode = cli.savedExitCode;
    process.argv = cli.savedArgv;
    for (const k of ENV_KEYS) {
        if (cli.savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = cli.savedEnv[k];
    }
    delete require.cache[MIGRATE_PATH];
    delete require.cache[DB_PATH];
    delete require.cache[DOTENV_PATH];
}

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
    // migrate.js reads INDEXER_DB_* from src/config.js's load-time CONFIG_ENV
    // snapshot, so config.js is re-evaluated after beforeEach pins them. The CLI
    // now lives under src/db/, so keep the fake Database seeded above out of
    // the src/db purge, or the real Database loads and main() hangs on a connect.
    requireWithFreshConfig(MIGRATE_PATH, { keep: [DB_PATH] });
}

describe('migrate CLI --file targeting @regression', function () {

    beforeEach(setUpTargetingCase);
    afterEach(tearDownTargetingCase);

    it('--file scopes the run to the named migration (passes opts.only)', async function () {
        process.argv = ['node', 'migrate.js', '--file', '2026-07-24-pubkeys-widen-uncompressed.sql'];
        const fake = makeFakeDb();
        loadMigrateWith(fake.FakeDatabase);
        await fake.done;
        assert.strictEqual(cli.exitStub.called, false);
        assert.deepStrictEqual(fake.runArgs, {
            includeManual: true,
            only: ['2026-07-24-pubkeys-widen-uncompressed.sql']
        }, 'the CLI must scope the run while keeping manual apply armed');
        assert.match(cli.consoleLogStub.getCalls().map(c => c.args[0]).join('\n'),
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
});

describe('migrate CLI --file targeting @regression', function () {

    beforeEach(setUpTargetingCase);
    afterEach(tearDownTargetingCase);

    it('--file with no value exits 2 before building a DB handle', function () {
        process.argv = ['node', 'migrate.js', '--file'];
        const fake = makeFakeDb();
        // process.exit is stubbed, so the exit(2) does not end the process; main()
        // must still bail rather than fall through to a blanket run. The refusal
        // precedes main()'s first await, so it has run by the time require returns.
        loadMigrateWith(fake.FakeDatabase);
        assert.strictEqual(cli.exitStub.calledWith(2), true, 'expected process.exit(2) on a valueless --file');
        assert.strictEqual(fake.runArgs, null, 'a refused argv must apply no migrations');
        assert.strictEqual(fake.poolEnded, false, 'a refused argv must not open a DB handle');
        assert.match(cli.consoleErrStub.getCalls().map(c => c.args[0]).join('\n'),
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

// Unrecognized argv. An ignored token falls through to the no-argument meaning,
// which is apply-everything, so `migrate.js --help` would apply every pending
// manual migration. Each case pins the refusal by what it APPLIES, not what it says.

describe('migrate CLI argv refusal @regression', function () {

    beforeEach(setUpTargetingCase);
    afterEach(tearDownTargetingCase);

    // The refusal is synchronous (it precedes main()'s first await), so a case that
    // must prove nothing ran asserts right after the require rather than awaiting a
    // pool.end() that a correct CLI never reaches.
    function loadWithArgv(args) {
        process.argv = ['node', 'migrate.js', ...args];
        const fake = makeFakeDb();
        loadMigrateWith(fake.FakeDatabase);
        return fake;
    }

    it('an unknown flag applies nothing and exits 2', function () {
        const fake = loadWithArgv(['--dry-run']);
        assert.strictEqual(fake.runArgs, null, 'an unknown flag must not run migrations');
        assert.strictEqual(fake.poolEnded, false, 'an unknown flag must not open a DB handle');
        assert.strictEqual(cli.exitStub.calledWith(2), true, 'expected process.exit(2)');
    });

    it('a bare positional applies nothing and exits 2 (it is not a --file value)', function () {
        const fake = loadWithArgv(['2026-07-24-pubkeys-widen-uncompressed.sql']);
        assert.strictEqual(fake.runArgs, null, 'a bare filename must not become a blanket run');
        assert.strictEqual(cli.exitStub.calledWith(2), true, 'expected process.exit(2)');
    });

    it('an empty --file= value applies nothing rather than widening to everything', function () {
        const fake = loadWithArgv(['--file=']);
        assert.strictEqual(fake.runArgs, null, 'an empty scope must not mean apply-everything');
        assert.strictEqual(cli.exitStub.calledWith(2), true, 'expected process.exit(2)');
    });

    it('--help and -h apply nothing and exit 0', function () {
        for (const flag of ['--help', '-h']) {
            const fake = loadWithArgv([flag]);
            assert.strictEqual(fake.runArgs, null, flag + ' must not run migrations');
            assert.strictEqual(fake.poolEnded, false, flag + ' must not open a DB handle');
            assert.strictEqual(cli.exitStub.calledWith(0), true, flag + ' must exit 0');
            assert.strictEqual(cli.exitStub.calledWith(2), false, flag + ' is not an error');
            cli.exitStub.resetHistory();
        }
    });

    it('the refusal prints both modes so an operator can tell them apart', function () {
        loadWithArgv(['--dry-run']);
        const printed = cli.consoleErrStub.getCalls().map(c => c.args[0]).join('\n');
        assert.match(printed, /APPLY EVERYTHING/, 'the usage must name the blanket mode');
        assert.match(printed, /APPLY ONE/, 'the usage must name the scoped mode');
        assert.match(printed, /--file/, 'the usage must show the flag that scopes a run');
    });
});

// The real binary as a child process, with no INDEXER_DB_* in the environment, so
// the guard is proven end to end and not only against a fake Database. `--help`
// exiting 0 unconfigured is also what proves it never reached the DB checks.

describe('migrate CLI --help as a child process @regression', function () {
    it('--help exits 0 with no DB environment loaded', function () {
        const res = runWithoutDbEnv('--help');
        assert.strictEqual(res.status, 0, '--help must succeed without a configured database');
    });

    it('--help prints both modes and no apply banner', function () {
        const res = runWithoutDbEnv('--help');
        assert.match(res.stdout, /APPLY EVERYTHING/);
        assert.match(res.stdout, /APPLY ONE/);
        assert.ok(!/applying pending migrations/.test(res.stdout), '--help must not start a run');
    });

    it('an unknown token exits 2 without reaching the DB environment check', function () {
        const res = runWithoutDbEnv('--dry-run');
        assert.strictEqual(res.status, 2);
        const all = res.stdout + res.stderr;
        // The environment guard's own sentence. An unconfigured no-argument run
        // prints it (the safety-guard cases above); its absence here is what shows
        // argv was settled before anything looked at the environment.
        assert.ok(!/must be set \(load the service \.env\)/.test(all),
            'argv must be refused before the environment guard runs');
        assert.ok(!/applying pending migrations/.test(all), 'an unknown token must not start a run');
    });
});

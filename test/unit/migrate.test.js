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
const { execFileSync } = require('child_process');

const MIGRATE = path.join(__dirname, '..', '..', 'src', 'migrate.js');

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

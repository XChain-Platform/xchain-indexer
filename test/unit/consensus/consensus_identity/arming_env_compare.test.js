/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/consensus/consensus_identity/arming_env_compare.test.js
 *
 * bin/consensus-identity.js --compare and the regtest arming environment. A
 * venue arms gate rows from its environment, so a reading taken under one
 * arming and compared under another differs for a reason that is not drift.
 * The tool records the whole arming as `env`, selects a pin block only on full
 * equality, and refuses everything else with one named line (exit 2), so exit
 * 1 only ever means real drift. Driven as a real child process with an explicit
 * environment, so the runner's own arming never decides a case.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '../../../..');
const BIN  = path.join(REPO, 'bin', 'consensus-identity.js');
const PIN  = path.join(REPO, 'bin', 'pins', 'at1-consensus-identity.json');
const { REGTEST_ARMING } = require(path.join(REPO, 'src', 'protocol_changes', 'shared_rows.js'));
const NAMES = Array.from(new Set(Object.values(REGTEST_ARMING).map((rule) => rule.env))).sort();
const ROLLCALL = { XC_ROLLCALL_REGTEST_ACTIVATION: 'armed', XC_ROLLCALL_GATES_REGTEST_ACTIVATION: 'armed' };

// The child sees PATH, HOME and TMPDIR plus exactly the levers a case names.
function run(args, levers = {}) {
    const env = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR']) if (process.env[key] !== undefined) env[key] = process.env[key];
    return spawnSync(process.execPath, [BIN, ...args], { cwd: REPO, encoding: 'utf8', env: Object.assign(env, levers) });
}

// Take a flat --out reading under `levers`, edit it with `mutate`, and return its path.
function flatReading(levers, mutate) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-arming-')), 'identity.json');
    const res = run(['--out', file, '--json'], levers);
    assert.strictEqual(res.status, 0, res.stderr);
    const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (mutate) mutate(identity);
    fs.writeFileSync(file, JSON.stringify(identity));
    return file;
}

// Assert a refusal: exit 2, nothing compared on stdout, one stderr line naming `name`.
function assertRefused(res, name) {
    assert.strictEqual(res.status, 2, res.stdout + res.stderr);
    assert.strictEqual(res.stdout, '', 'a refused comparison prints no ok or MISMATCH line');
    assert.strictEqual(res.stderr.trim().split('\n').length, 1, res.stderr);
    assert.ok(res.stderr.includes(name), res.stderr);
    assert.ok(res.stderr.includes('different regtest arming environment'), res.stderr);
}

describe('bin/consensus-identity.js --compare against the committed pin and the arming env', function () {
    this.timeout(60000);

    it('passes bare with no lever set, and armed with exactly the pin\'s levers', function () {
        assert.strictEqual(run(['--compare', PIN]).status, 0);
        const armed = run(['--compare', PIN], ROLLCALL);
        assert.strictEqual(armed.status, 0, armed.stdout + armed.stderr);
        assert.ok(!armed.stdout.includes('MISMATCH'), armed.stdout);
    });

    it('refuses a lever the pin did not arm, instead of reporting rules drift', function () {
        const lever = { XC_MIRROR_ADMISSION_ACTIVATION: 'armed' };
        assertRefused(run(['--compare', PIN], Object.assign({}, ROLLCALL, lever)), 'XC_MIRROR_ADMISSION_ACTIVATION');
        assertRefused(run(['--compare', PIN], { XC_ANCHOR_STAKE_REGTEST_ACTIVATION: 'armed' }),
            'XC_ANCHOR_STAKE_REGTEST_ACTIVATION');
    });

    it('refuses half of the pin\'s armed pair rather than falling back to the bare block', function () {
        assertRefused(run(['--compare', PIN], { XC_ROLLCALL_REGTEST_ACTIVATION: 'armed' }),
            'XC_ROLLCALL_REGTEST_ACTIVATION');
    });
});

describe('bin/consensus-identity.js --compare against a flat reading and the arming env', function () {
    this.timeout(60000);

    it('records every REGTEST_ARMING variable as env, null when unset', function () {
        const { codeIdentity } = require(BIN);
        assert.deepStrictEqual(Object.keys(codeIdentity('regtest').env), NAMES);
        const identity = JSON.parse(fs.readFileSync(flatReading(ROLLCALL), 'utf8'));
        assert.deepStrictEqual(Object.keys(identity.env), NAMES);
        assert.strictEqual(identity.env.XC_ROLLCALL_REGTEST_ACTIVATION, 'armed');
        assert.strictEqual(identity.env.XC_MIRROR_ADMISSION_ACTIVATION, null);
    });

    it('compares a flat reading under its own arming, and refuses it under another', function () {
        const file = flatReading(ROLLCALL);
        const same = run(['--compare', file], ROLLCALL);
        assert.strictEqual(same.status, 0, same.stdout + same.stderr);
        assertRefused(run(['--compare', file]), 'XC_ROLLCALL_GATES_REGTEST_ACTIVATION');
    });

    it('reads a flat reading with no env as taken bare', function () {
        const file = flatReading({}, (identity) => { delete identity.env; });
        assert.strictEqual(run(['--compare', file]).status, 0);
        assertRefused(run(['--compare', file], ROLLCALL), 'XC_ROLLCALL_REGTEST_ACTIVATION');
    });

    it('refuses a flat reading whose env is not an object', function () {
        const res = run(['--compare', flatReading({}, (identity) => { identity.env = 'armed'; })]);
        assert.strictEqual(res.status, 2, res.stdout + res.stderr);
        assert.match(res.stderr, /env must be a JSON object/);
    });
});

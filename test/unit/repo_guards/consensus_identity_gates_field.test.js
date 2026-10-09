'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { codeIdentity } = require('../../../bin/consensus-identity.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const REPO = path.resolve(__dirname, '..', '..', '..');
const BIN = path.join(REPO, 'bin', 'consensus-identity.js');
const PIN = path.join(REPO, 'bin', 'pins', 'at1-consensus-identity.json');

function run(args) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-identity-stdout-'));
    const stdoutPath = path.join(dir, 'stdout');
    let stdoutFd;
    try {
        stdoutFd = fs.openSync(stdoutPath, 'w');
        // The CLI calls process.exit after logging, so pipe-backed stdout can lose its tail on a loaded host.
        const result = spawnSync(process.execPath, [BIN, ...args], {
            cwd: REPO,
            encoding: 'utf8',
            env: childEnv(),
            stdio: ['ignore', stdoutFd, 'pipe'],
            // A cold comparison is quick, but loaded CI hosts can take over 30s to scan the carriers.
            timeout: 60000,
        });
        fs.closeSync(stdoutFd);
        stdoutFd = undefined;
        result.stdout = fs.readFileSync(stdoutPath, 'utf8');
        return result;
    } finally {
        if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// The variables the child is allowed to see. A regtest venue arms gate rows from
// the environment (src/protocol_changes/shared_rows.js REGTEST_ARMING), and
// --compare selects a pin block only when the WHOLE arming environment matches it,
// refusing (exit 2) otherwise, so a process holding one stray lever answers to
// neither block. A suite that
// throws between arming a lever and restoring it leaves exactly that state, and
// an inherited environment would carry it into this guard and red it for a reason
// that is not drift. The list is closed rather than a subtraction of known levers,
// so a lever added later cannot ride in unnoticed.
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR'];

function childEnv() {
    const env = {};
    for (const key of CHILD_ENV_KEYS) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return env;
}

function committedSiblingFile(file, verdict) {
    if (!verdict.reason || !verdict.reason.includes('resolves through a symlink into the live main checkout'))
        return null;
    const rootResult = spawnSync('git', ['-C', path.dirname(file), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (rootResult.status !== 0) return null;
    const root = rootResult.stdout.trim();
    const revResult = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (revResult.status !== 0) return null;
    const rel = path.relative(root, fs.realpathSync(file)).split(path.sep).join('/');
    const showResult = spawnSync('git', ['-C', root, 'show', revResult.stdout.trim() + ':' + rel], { encoding: 'utf8' });
    return showResult.status === 0 ? showResult.stdout : null;
}

describe('consensus identity GATES field and pin comparison', function () {
    it('matches the hub pinned GATES field hash', function () {
        const hubRoot = process.env.XCHAIN_HUB_DIR || path.resolve(REPO, '..', 'xchain-hub');
        const candidate = path.join(hubRoot, 'bin', 'pins', 'at1-consensus-identity.json');
        const sibling = siblingCheckout(REPO, candidate, { ownRoot: REPO });
        const committed = sibling.usable ? null : committedSiblingFile(candidate, sibling);
        if (!sibling.usable && committed === null)
            return skipOrFail(this, sibling, 'the hub GATES field hash guard');
        const hubPin = JSON.parse(committed === null ? fs.readFileSync(sibling.path, 'utf8') : committed);
        assert.strictEqual(codeIdentity('regtest').gates_field_hash, hubPin.gates_field_hash);
    });

    it('exits zero against the committed pin', function () {
        const result = run(['--compare', PIN]);
        assert.strictEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /^ok gates_field_hash$/m);
    });

    it('exits zero with an arming lever left set in this process', function () {
        // Keep Mocha's bound above the child-process bound so cleanup and assertions can finish.
        this.timeout(70000);
        // One lever of the pair, which is what a hook that throws between arming and
        // restoring leaves behind. The child must not see it.
        const key = 'XC_ROLLCALL_REGTEST_ACTIVATION';
        const had = Object.prototype.hasOwnProperty.call(process.env, key);
        const previous = process.env[key];
        process.env[key] = 'armed';
        try {
            assert.strictEqual(childEnv()[key], undefined);
            const result = run(['--compare', PIN]);
            assert.strictEqual(result.status, 0, result.stdout + result.stderr);
            assert.match(result.stdout, /^ok gates_field_hash$/m);
        } finally {
            if (had) process.env[key] = previous;
            else delete process.env[key];
        }
    });

    it('exits one and names an altered scalar field', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-identity-pin-'));
        const tempPin = path.join(dir, 'pin.json');
        try {
            const pin = JSON.parse(fs.readFileSync(PIN, 'utf8'));
            pin.bare_checkout.gates_field_hash = '0'.repeat(64);
            fs.writeFileSync(tempPin, JSON.stringify(pin));
            const result = run(['--compare', tempPin]);
            assert.strictEqual(result.status, 1, result.stdout + result.stderr);
            assert.match(result.stdout, /^MISMATCH gates_field_hash:/m);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

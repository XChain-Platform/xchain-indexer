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
 * test/unit/consensus/consensus_identity_cli.test.js
 *
 * bin/consensus-identity.js --assert-no-absent, the flag the hub's copy of this
 * tool has carried for a while and the indexer's lacked until now, which is
 * exactly how a miscounted gate total (29 instead of the true 33) survived on
 * the indexer side and reached four lane reports: nothing refused to run with a
 * gate unresolved. Driven as a real child process against the real src/ tree
 * (never a stub), because the defect this flag guards against is a wrong number
 * on a real digest, not a wrong number on a fake one.
 *
 * Every shared gate VALUE is an activation-registry row now, so the state the
 * flag was written for (a carrier moved out from under the build reading as
 * ABSENT) cannot be reached by hiding a carrier: the tool still reads 33 and
 * exits 0, which is the point. A build that LACKS a row is a defect the digest
 * refuses to measure at all, flag or no flag: the registry throws naming the
 * key and the tool exits 2 with that one line. The refusal is driven through a
 * preload that makes the registry miss one key in the child, because no real
 * checkout may drop a row.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { spawnSync } = require('child_process');

const BIN     = path.resolve(__dirname, '../../../bin/consensus-identity.js');
const REPO    = path.resolve(__dirname, '../../..');
// A real shared-gate carrier, temporarily renamed out from under the tool: the
// value it once carried is a registry row, so the digest must not notice. The
// price-pair gate is the victim since W5 (the royalty shim the case used before
// is gone: its row is read by key and there is no file left to hide).
const VICTIM  = path.resolve(REPO, 'src/consensus/gates/price_pair_gate.js');
const HIDDEN  = VICTIM + '.hidden-for-test';
const KEY     = 'price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION';
const REGISTRY = path.resolve(REPO, 'src/consensus/gate_registry.js');

function run(args, preload) {
    const argv = preload ? ['-r', preload, BIN, ...args] : [BIN, ...args];
    return spawnSync(process.execPath, argv, { cwd: REPO, encoding: 'utf8' });
}

// A preload for the child: the registry's get() misses KEY and answers every other
// key as shipped. Written to a scratch directory, never under src/.
function missingRowPreload() {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'identity-miss-'));
    const file = path.join(dir, 'missing_row.js');
    fs.writeFileSync(file,
        'const reg = require(' + JSON.stringify(REGISTRY) + ');\n'
        + 'const realGet = reg.get;\n'
        + 'reg.get = (k) => {\n'
        + '    if (k === ' + JSON.stringify(KEY) + ') throw new reg.RegistryMissError(k);\n'
        + '    return realGet(k);\n'
        + '};\n');
    return file;
}

describe('bin/consensus-identity.js --assert-no-absent', function () {

    it('exits 0 and prints no ABSENT line when every shared gate resolves', function () {
        const res = run(['--assert-no-absent', '--json']);
        assert.strictEqual(res.status, 0, res.stderr);
        assert.strictEqual(res.stderr, '');
        const identity = JSON.parse(res.stdout);
        assert.strictEqual(identity.consensus_rules_gates_absent, 0);
        assert.strictEqual(identity.consensus_rules_gates_resolved, 33);
    });

    it('reads every gate with a carrier hidden: the value is the registry row, never the file', function () {
        assert.ok(fs.existsSync(VICTIM), 'fixture assumes this carrier is present at HEAD');
        const before = fs.readFileSync(VICTIM);
        fs.renameSync(VICTIM, HIDDEN);
        let res;
        try {
            res = run(['--assert-no-absent', '--json']);
        } finally {
            fs.renameSync(HIDDEN, VICTIM);
        }
        // Byte-exact restore, not just "the file exists again": a test that leaves the
        // fixture in a mutated state corrupts every case run after it in the same file.
        assert.ok(before.equals(fs.readFileSync(VICTIM)), 'fixture carrier must be restored byte-exact');

        assert.strictEqual(res.status, 0, res.stdout + res.stderr);
        const identity = JSON.parse(res.stdout);
        assert.strictEqual(identity.consensus_rules_gates_absent, 0);
        assert.strictEqual(identity.consensus_rules_gates_resolved, 33);
        assert.ok(identity.consensus_rules_gates[KEY], 'the hidden carrier\'s gate still resolves');
    });

    it('REFUSES (exit 2) naming the key when a registry row is missing, with the flag', function () {
        const res = run(['--assert-no-absent', '--json'], missingRowPreload());
        assert.strictEqual(res.status, 2, res.stdout + res.stderr);
        assert.strictEqual(res.stdout, '', 'no identity may print over a rules set the build lacks');
        assert.ok(res.stderr.includes(KEY), 'must name the missing row on stderr: ' + res.stderr);
        assert.strictEqual(res.stderr.trim().split('\n').length, 1, 'one clean line, not a stack: ' + res.stderr);
    });

    it('carries the refusal without the flag too: a missing row is never a lower count', function () {
        const res = run(['--json'], missingRowPreload());
        assert.strictEqual(res.status, 2, res.stdout + res.stderr);
        assert.strictEqual(res.stdout, '');
        assert.ok(res.stderr.includes(KEY), res.stderr);
    });
});

describe('bin/consensus-identity.js argument validation', function () {
    this.timeout(20000);

    it('refuses an unknown flag before measuring the checkout', function () {
        const res = run(['--out', 'ignored.json']);
        assert.strictEqual(res.status, 2);
        assert.strictEqual(res.stdout, '');
        assert.match(res.stderr, /REFUSING: unknown flag --out/);
        assert.match(res.stderr, /Usage: node bin\/consensus-identity\.js \[--json\] \[--compare <pin>\]/);
    });

    it('refuses a bare positional argument the same way', function () {
        const res = run(['pin.json']);
        assert.strictEqual(res.status, 2);
        assert.match(res.stderr, /REFUSING: unknown flag pin\.json/);
    });

    it('keeps JSON output working', function () {
        const res = run(['--json']);
        assert.strictEqual(res.status, 0, res.stderr);
        assert.doesNotThrow(() => JSON.parse(res.stdout));
    });

    it('documents both compare blocks without advertising an output-file flag', function () {
        const res = run(['--help']);
        assert.strictEqual(res.status, 0, res.stderr);
        assert.match(res.stdout, /node bin\/consensus-identity\.js --compare <pin>/);
        assert.match(res.stdout, /bare_checkout block/);
        assert.match(res.stdout, /armed_regtest_venue block/);
        assert.match(res.stdout, /XC_ROLLCALL_REGTEST_ACTIVATION=armed XC_ROLLCALL_GATES_REGTEST_ACTIVATION=armed/);
        assert.ok(!res.stdout.includes('--out'));
    });
});

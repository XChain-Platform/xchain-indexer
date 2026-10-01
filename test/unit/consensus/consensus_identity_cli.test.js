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
 * ABSENT) cannot be reached by hiding a carrier: the tool still resolves every
 * shared gate (the assertions below pin the count) and exits 0, which is the
 * point. A build that LACKS a row is a defect the digest refuses to measure at
 * all, flag or no flag: the registry throws naming the key and the tool exits
 * 2 with that one line. The refusal is driven through a preload that makes the
 * registry miss one key in the child, because no real checkout may drop a row.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { spawnSync } = require('child_process');

const BIN     = path.resolve(__dirname, '../../../bin/consensus-identity.js');
const REPO    = path.resolve(__dirname, '../../..');
// A real shared-gate carrier hidden from the child process: the value it once
// carried is a registry row, so the digest must not notice. The price-pair gate
// is the victim since W5 (the royalty shim the case used before is gone: its row
// is read by key and there is no file left to hide).
const VICTIM  = path.resolve(REPO, 'src/consensus/gates/price_pair_gate.js');
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

function hiddenCarrierPreload() {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'identity-hide-'));
    const file = path.join(dir, 'hidden_carrier.js');
    fs.writeFileSync(file,
        'const Module = require(\'module\');\n'
        + 'const realResolveFilename = Module._resolveFilename;\n'
        + 'Module._resolveFilename = function (request, parent, isMain, options) {\n'
        + '    const resolved = realResolveFilename.call(this, request, parent, isMain, options);\n'
        + '    if (resolved === ' + JSON.stringify(VICTIM) + ') {\n'
        + '        const error = new Error("Cannot find module \'" + request + "\'");\n'
        + '        error.code = \'MODULE_NOT_FOUND\';\n'
        + '        throw error;\n'
        + '    }\n'
        + '    return resolved;\n'
        + '};\n');
    return file;
}

describe('bin/consensus-identity.js --assert-no-absent', function () {

    it('exits 0 and prints no ABSENT line when every shared gate resolves', function () {
        const res = run(['--assert-no-absent', '--json']);
        assert.strictEqual(res.status, 0, res.stderr);
        assert.strictEqual(res.stderr, '');
        const identity = JSON.parse(res.stdout);
        assert.deepStrictEqual(identity.absent_gates, []);
        assert.strictEqual(identity.gate_key_count, 41);
    });

    it('reads every gate with a carrier hidden: the value is the registry row, never the file', function () {
        assert.ok(fs.existsSync(VICTIM), 'fixture assumes this carrier is present at HEAD');
        const res = run(['--assert-no-absent', '--json'], hiddenCarrierPreload());
        assert.strictEqual(res.status, 0, res.stdout + res.stderr);
        const identity = JSON.parse(res.stdout);
        assert.deepStrictEqual(identity.absent_gates, []);
        assert.strictEqual(identity.gate_key_count, 41);
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

    it('refuses an unknown flag before producing output', function () {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'identity-phantom-'));
        const output = path.join(dir, 'ignored.json');
        const res = run(['--phantom-write', output]);
        assert.strictEqual(res.status, 2);
        assert.strictEqual(res.stdout, '');
        assert.strictEqual(res.stderr, 'unknown flag: --phantom-write\n');
        assert.strictEqual(fs.existsSync(output), false);
    });

    it('refuses a positional argument as an unknown flag', function () {
        const res = run(['ignored.json']);
        assert.strictEqual(res.status, 2);
        assert.strictEqual(res.stdout, '');
        assert.strictEqual(res.stderr, 'unknown flag: ignored.json\n');
    });

    it('refuses a value option whose value is missing', function () {
        const res = run(['--out']);
        assert.strictEqual(res.status, 2);
        assert.strictEqual(res.stdout, '');
        assert.strictEqual(res.stderr, '--out requires a value\n');
    });

    it('implements the hub-compatible --out JSON write', function () {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'identity-out-'));
        const output = path.join(dir, 'nested', 'identity.json');
        const res = run(['--out', output, '--json']);

        assert.strictEqual(res.status, 0, res.stderr);
        assert.strictEqual(res.stderr, '');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(output, 'utf8')), JSON.parse(res.stdout));
    });
});

// A function canonicalizes to undefined, which JSON drops and a comparer reads as equal.
describe('bin/consensus-identity.js function-valued gate rows', function () {
    const FUNCTION_KEYS = ['encodeAdmitBlocks', 'decodeAdmitBlocks', 'isAdmissionEra', 'admissionCanonicalField']
        .map(name => 'mirror_admission_activation.' + name);

    it('emits one row per resolved gate, naming a function gate by presence', function () {
        const res = run(['--json']);
        assert.strictEqual(res.status, 0, res.stderr);
        const identity = JSON.parse(res.stdout);
        assert.strictEqual(Object.keys(identity.consensus_rules_gates).length, identity.gate_key_count,
            'the printed map must hold every gate the count names');
        for (const key of FUNCTION_KEYS) assert.strictEqual(identity.consensus_rules_gates[key], '<function>', key);
    });

    it('reports a pin that lacks a function gate row as a mismatch', function () {
        const { codeIdentity, compareIdentity } = require(BIN);
        const fresh = codeIdentity('regtest');
        const pinGates = Object.assign({}, fresh.consensus_rules_gates);
        delete pinGates[FUNCTION_KEYS[0]];
        const row = compareIdentity({ consensus_rules_gates: pinGates }, fresh)
            .find(r => r.field === 'consensus_rules_gates.' + FUNCTION_KEYS[0]);
        assert.ok(row, 'the dropped row must be compared by name');
        assert.strictEqual(row.same, false, 'a row the pin lacks must not read as ok');
    });
});

describe('bin/consensus-identity.js --compare against a flat --out reading', function () {
    // Write this tree's own --out reading, edited by `mutate`, and return its path.
    function flatPin(mutate) {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'identity-flat-'));
        const file = path.join(dir, 'identity.json');
        assert.strictEqual(run(['--out', file, '--json']).status, 0);
        const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (mutate) mutate(identity);
        fs.writeFileSync(file, JSON.stringify(identity));
        return file;
    }

    // Write `body` as a pin file and return its path.
    function pinFile(body) {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'identity-pin-'));
        const file = path.join(dir, 'pin.json');
        fs.writeFileSync(file, JSON.stringify(body));
        return file;
    }

    it('round-trips its own --out file with every field ok, arrays included', function () {
        const res = run(['--compare', flatPin()]);
        assert.strictEqual(res.status, 0, res.stdout + res.stderr);
        assert.strictEqual(res.stderr, '');
        assert.ok(!res.stdout.includes('MISMATCH'), res.stdout);
        assert.ok(res.stdout.split('\n').includes('ok absent_gates'), res.stdout);
    });

    it('skips a stored tip visibly rather than reading it as a mismatch', function () {
        const res = run(['--compare', flatPin((id) => { id.tip = { block_index: 1, state_hash: 'x' }; })]);
        assert.strictEqual(res.status, 0, res.stdout + res.stderr);
        assert.ok(res.stdout.includes('skip tip'), res.stdout);
        assert.ok(!res.stdout.includes('MISMATCH'), res.stdout);
    });

    it('still reports a moved gate in a flat reading as a mismatch', function () {
        const res = run(['--compare', flatPin((id) => { id.consensus_rules_gates[KEY] = 'moved'; })]);
        assert.strictEqual(res.status, 1, res.stdout + res.stderr);
        assert.ok(res.stdout.includes('MISMATCH consensus_rules_gates.' + KEY), res.stdout);
    });

    it('refuses a shapeless, hub or blockless pin with one named line (exit 2)', function () {
        const bodies = [{}, [], { hub_schema_version: 1, consensus_rules_digest: 'x' },
            { armed_regtest_venue: { env: { XC_IDENTITY_TEST_UNSET_VAR: 'armed' } } }];
        for (const body of bodies) {
            const res = run(['--compare', pinFile(body)]);
            assert.strictEqual(res.status, 2, JSON.stringify(body) + res.stdout + res.stderr);
            assert.strictEqual(res.stderr.trim().split('\n').length, 1, res.stderr);
            assert.ok(!res.stderr.includes('Cannot convert'), res.stderr);
        }
    });
});

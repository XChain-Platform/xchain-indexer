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
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { spawnSync } = require('child_process');

const BIN     = path.resolve(__dirname, '../../../bin/consensus-identity.js');
const REPO    = path.resolve(__dirname, '../../..');
// A real shared-gate carrier, temporarily renamed out from under the tool to make
// one gate genuinely ABSENT (the file-missing case consensus_rules_digest.js
// already distinguishes from a carrier that is present but fails to load).
const VICTIM  = path.resolve(REPO, 'src/cross_chain_royalty_activation.js');
const HIDDEN  = VICTIM + '.hidden-for-test';

function run(args) {
    return spawnSync(process.execPath, [BIN, ...args], { cwd: REPO, encoding: 'utf8' });
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

    it('is a no-op without the flag even when a gate is genuinely absent', function () {
        assert.ok(fs.existsSync(VICTIM), 'fixture assumes this carrier is present at HEAD');
        fs.renameSync(VICTIM, HIDDEN);
        let res;
        try {
            res = run(['--json']);
        } finally {
            fs.renameSync(HIDDEN, VICTIM);
        }
        assert.strictEqual(res.status, 0, 'no --assert-no-absent: an absent gate must not affect the exit code');
        const identity = JSON.parse(res.stdout);
        assert.strictEqual(identity.consensus_rules_gates_absent, 1);
    });

    it('REFUSES (exit 1) and names the gate when one shared gate is genuinely absent', function () {
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

        assert.strictEqual(res.status, 1, res.stdout + res.stderr);
        assert.ok(res.stderr.includes('cross_chain_royalty_activation.CROSS_CHAIN_ROYALTY_ACTIVATION'),
            'must name the absent gate on stderr: ' + res.stderr);
        const identity = JSON.parse(res.stdout);
        assert.strictEqual(identity.consensus_rules_gates_absent, 1);
        assert.deepStrictEqual(identity.consensus_rules_gates_absent_keys,
            ['cross_chain_royalty_activation.CROSS_CHAIN_ROYALTY_ACTIVATION']);
    });

    it('carries the refusal through --assert-no-absent without --json too', function () {
        fs.renameSync(VICTIM, HIDDEN);
        let res;
        try {
            res = run(['--assert-no-absent']);
        } finally {
            fs.renameSync(HIDDEN, VICTIM);
        }
        assert.strictEqual(res.status, 1);
        assert.ok(res.stderr.includes('cross_chain_royalty_activation'), res.stderr);
    });
});

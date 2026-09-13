'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// the health endpoint exposes a fingerprint of the consensus-gate
// source files in the running build so a fleet sweep can confirm every
// deployed process carries the same armed map before a flag-day height.

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { computeArmedMapFingerprint } = require('../../src/armedMapFingerprint');

describe('armedMapFingerprint', function () {

    it('covers every *_activation.js gate file plus the fixed carriers', function () {
        const { files } = computeArmedMapFingerprint();
        const srcDir = path.resolve(__dirname, '..', '..', 'src');
        const expected = fs.readdirSync(srcDir).filter(f => f.endsWith('_activation.js'));
        for (const f of expected)
            assert.ok(files[f], 'gate file ' + f + ' missing from fingerprint');
        assert.ok(files['stateHash.js'], 'stateHash.js missing from fingerprint');
    });

    // Make the no-silent-exclusion claim enforceable rather than asserted in a
    // comment. An enumeration of *_activation.js plus two hand-listed names leaves
    // equivocation_header.js, stake_weighted_quorum.js, capability_min_stake_history.js
    // and snapshot_reorg_buffer.js carrying armed heights outside the fingerprint, and
    // a flat listing cannot see the nested carriers at all; a process on a stale copy
    // of any of them then publishes a fingerprint identical to a correctly-armed
    // peer's. This test is the only thing standing between the explicit list in
    // FIXED_GATE_FILES and the next silent omission.
    it('every activation-map carrier under src/ is in the fingerprint set', function () {
        const { files } = computeArmedMapFingerprint();
        const srcDir = path.resolve(__dirname, '..', '..', 'src');
        // A carrier DECLARES an activation map. Declaration-shaped on purpose, not a
        // keyword search: dozens of files mention ARMED in prose, and making prose the
        // membership rule would let a comment edit move a deployed fingerprint.
        const CARRIER_DECL = /^\s*(?:const|let|var)\s+[A-Z0-9_]*ACTIVATIONS?[A-Z0-9_]*\s*=\s*(?:Object\.freeze\()?\{/m;
        const found = [];
        (function walk(dir, rel){
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === 'node_modules' || e.name === '.git') continue;
                const abs = path.join(dir, e.name);
                const r   = rel ? rel + '/' + e.name : e.name;
                if (e.isDirectory()) { walk(abs, r); continue; }
                if (!e.name.endsWith('.js')) continue;
                if (CARRIER_DECL.test(fs.readFileSync(abs, 'utf8'))) found.push(r);
            }
        })(srcDir, '');
        // An empty or near-empty scan would pass while proving nothing, which is the
        // same shape of reassuring silence the omission itself had.
        assert.ok(found.length > 5, 'the carrier scan found ' + found.length +
            ' files, too few to be a real scan; fix the scan, not this bound');
        const uncovered = found.filter(f => !files[f]);
        assert.deepStrictEqual(uncovered, [], 'these src/ files declare an activation ' +
            'map but sit outside the armed-map fingerprint, so a deployed process on a ' +
            'stale copy of one is invisible to the fleet sweep: ' + uncovered.join(', ') +
            ' (add each to FIXED_GATE_FILES in src/armedMapFingerprint.js, in BOTH ' +
            'repos, and redeploy both fleets in one wave)');
    });

    it('per-file hashes are the sha256 of the actual file bytes', function () {
        const { files } = computeArmedMapFingerprint();
        const p = path.resolve(__dirname, '..', '..', 'src', 'stateHash.js');
        const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        assert.strictEqual(files['stateHash.js'], h);
    });

    it('fingerprint is a stable 64-hex string (memoized per process)', function () {
        const a = computeArmedMapFingerprint();
        const b = computeArmedMapFingerprint();
        assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
        assert.strictEqual(a, b);
    });
});

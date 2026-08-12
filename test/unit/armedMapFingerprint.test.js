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

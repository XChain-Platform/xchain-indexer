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
    return spawnSync(process.execPath, [BIN, ...args], { cwd: REPO, encoding: 'utf8' });
}

describe('consensus identity GATES field and pin comparison', function () {
    it('matches the hub pinned GATES field hash', function () {
        const hubRoot = process.env.XCHAIN_HUB_DIR || path.resolve(REPO, '..', 'xchain-hub');
        const candidate = path.join(hubRoot, 'bin', 'pins', 'at1-consensus-identity.json');
        const sibling = siblingCheckout(REPO, candidate, { ownRoot: REPO });
        if (!sibling.usable) return skipOrFail(this, sibling, 'the hub GATES field hash guard');
        const hubPin = JSON.parse(fs.readFileSync(sibling.path, 'utf8'));
        assert.strictEqual(codeIdentity('regtest').gates_field_hash, hubPin.gates_field_hash);
    });

    it('exits zero against the committed pin', function () {
        const result = run(['--compare', PIN]);
        assert.strictEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /^ok gates_field_hash$/m);
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

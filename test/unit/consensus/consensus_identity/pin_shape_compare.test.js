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
 * test/unit/consensus/consensus_identity/pin_shape_compare.test.js
 *
 * bin/consensus-identity.js --compare against a pin that lacks fields. A field
 * either side lacks is a MISMATCH (exit 1), and a two-block pin block without
 * the network or a cross-repo value is refused (exit 2), so an empty or
 * half-written block can never compare nothing and pass. Also covers the
 * regenerator appending the fields a block lacks, which keeps the committed
 * pin complete. Driven as a real child process with a closed environment.
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

// The child sees PATH, HOME and TMPDIR only, so no stray arming lever picks the wrong block.
function run(args) {
    const env = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR']) if (process.env[key] !== undefined) env[key] = process.env[key];
    return spawnSync(process.execPath, [BIN, ...args], { cwd: REPO, encoding: 'utf8', env });
}

// Write `body` as a pin file in a scratch directory and return its path.
function pinFile(body) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-shape-')), 'pin.json');
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
}

describe('bin/consensus-identity.js compareIdentity over the union of fields', function () {
    this.timeout(60000);

    it('reports every fresh field as a mismatch against an empty pin block', function () {
        const { codeIdentity, compareIdentity } = require(BIN);
        const fresh = codeIdentity('regtest');
        const rows = compareIdentity({}, fresh);
        assert.ok(rows.length > 0, 'an empty pin must still yield rows');
        assert.ok(rows.every((row) => row.same === false), JSON.stringify(rows.filter((row) => row.same)));
        const top = new Set(rows.map((row) => row.field.split('.')[0]));
        for (const field of Object.keys(fresh)) {
            if (field === 'env' || field === 'tip') assert.ok(!top.has(field), field);
            else assert.ok(top.has(field), 'no row for ' + field);
        }
    });

    it('expands an object field the pin lacks key by key without throwing', function () {
        const { codeIdentity, compareIdentity } = require(BIN);
        const fresh = codeIdentity('regtest');
        const pin = Object.assign({}, fresh);
        delete pin.coin_registry_consensus_hashes;
        const rows = compareIdentity(pin, fresh).filter((row) => row.field.startsWith('coin_registry_consensus_hashes.'));
        assert.strictEqual(rows.length, Object.keys(fresh.coin_registry_consensus_hashes).length);
        assert.ok(rows.every((row) => row.before === undefined && row.same === false));
    });
});

describe('bin/consensus-identity.js --compare against a pin block missing fields', function () {
    this.timeout(120000);

    it('refuses an empty or network-only bare block with one line naming a missing field (exit 2)', function () {
        for (const block of [{}, { network: 'regtest' }]) {
            const res = run(['--compare', pinFile({ bare_checkout: block })]);
            assert.strictEqual(res.status, 2, JSON.stringify(block) + res.stdout + res.stderr);
            assert.strictEqual(res.stdout, '');
            assert.strictEqual(res.stderr.trim().split('\n').length, 1, res.stderr);
            assert.match(res.stderr, /bare_checkout block has no .*consensus_rules_digest/);
        }
    });

    it('exits one naming gates_field when the committed pin drops it from the bare block', function () {
        const pin = JSON.parse(fs.readFileSync(PIN, 'utf8'));
        assert.strictEqual(typeof pin.bare_checkout.gates_field, 'string', 'the committed pin carries gates_field');
        delete pin.bare_checkout.gates_field;
        const res = run(['--compare', pinFile(pin)]);
        assert.strictEqual(res.status, 1, res.stdout + res.stderr);
        assert.match(res.stdout, /^MISMATCH gates_field: <missing> -> "/m);
    });

    it('exits zero against the committed pin with gates_field and absent_gates compared', function () {
        const res = run(['--compare', PIN]);
        assert.strictEqual(res.status, 0, res.stdout + res.stderr);
        const lines = res.stdout.split('\n');
        for (const field of ['gates_field', 'absent_gates', 'armed_map_fingerprint_unreadable_reason']) {
            assert.ok(lines.includes('ok ' + field), field + '\n' + res.stdout);
        }
    });
});

describe('bin/regenerate-identity-pin.js refresh of a block', function () {

    it('appends the fields the reading carries after the block\'s own, never env or tip', function () {
        const { refresh } = require(path.join(REPO, 'bin', 'regenerate-identity-pin.js'));
        const block = { network: 'old', consensus_rules_digest: 'old' };
        const reading = { network: 'regtest', gates_field: 'a,b', consensus_rules_digest: 'd',
            env: { X: null }, tip: { state_hash: 'x' }, absent_gates: [] };
        refresh(block, reading);
        assert.deepStrictEqual(Object.keys(block), ['network', 'consensus_rules_digest', 'gates_field', 'absent_gates']);
        assert.strictEqual(block.network, 'regtest');
        assert.strictEqual(block.gates_field, 'a,b');
    });

    it('keeps an armed block\'s own env as written', function () {
        const { refresh } = require(path.join(REPO, 'bin', 'regenerate-identity-pin.js'));
        const block = { env: { LEVER: 'armed' }, network: 'old' };
        refresh(block, { network: 'regtest', env: { LEVER: 'armed', OTHER: null } });
        assert.deepStrictEqual(block, { env: { LEVER: 'armed' }, network: 'regtest' });
    });
});

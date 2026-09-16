/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Guard on the per-file schema naming this tier depends on.
 *
 * Two files sharing one schema is what lets an abandoned hook (mocha fails a
 * hook past its timeout but does not cancel the promise inside it) keep running
 * DDL against a database the next file has already dropped and recreated. The
 * assertions below are the properties that keep that from coming back, and they
 * need no database of their own.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { scopedDbName } = require('./setup/db-connection');

// What the CI gate hands the tier: ci_<declared name>_<run id>, clamped to 60.
// See .ci-databases and the ci-databases block in the gate.
const GATE_BASE = 'ci_xchain_test_indexer_a1b2c3d4_12345';

function testFileKeys(dir, prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (entry.isDirectory()) return testFileKeys(path.join(dir, entry.name), prefix + entry.name + '/');
        return entry.name.endsWith('.test.js') ? [prefix + entry.name] : [];
    });
}

describe('integration schema isolation @regression @tier1', function () {
    const keys = testFileKeys(__dirname);

    it('gives every test file in the tier a schema of its own', function () {
        assert.ok(keys.length > 1, 'expected the integration tier to hold more than one test file');
        const names = new Map();
        for (const key of keys) {
            const name = scopedDbName(GATE_BASE, key);
            assert.ok(!names.has(name),
                `${key} and ${names.get(name)} would share schema ${name}`);
            names.set(name, key);
        }
    });

    it('keeps the ci_ prefix the venue grant is restricted to', function () {
        // A schema outside ci_% is created happily on that venue and then
        // refuses INSERT with error 1142, which reads as a product failure.
        for (const key of keys) {
            const name = scopedDbName(GATE_BASE, key);
            assert.ok(name.startsWith('ci_'), `${key} derived ${name}, outside the ci_ grant`);
            assert.match(name, /^[A-Za-z0-9_]+$/, `${key} derived an unquotable name: ${name}`);
        }
    });

    it('stays inside the 64-character identifier limit, even from a base at the gate clamp', function () {
        const clamped = ('ci_' + 'x'.repeat(80)).slice(0, 60);   // the gate's own cut
        for (const key of keys) {
            for (const base of [GATE_BASE, clamped]) {
                const name = scopedDbName(base, key);
                assert.ok(name.length <= 64, `${key} from a ${base.length}-char base derived ${name.length} chars`);
            }
        }
    });

    it('separates bases that differ only past the cut', function () {
        // Truncating a long base risks cutting off the run id the gate put at
        // the end, which would put two concurrent runs back on one schema.
        const key = 'scenarios/05-reorg.test.js';
        const runA = ('ci_' + 'y'.repeat(50) + '_runA').slice(0, 60);
        const runB = ('ci_' + 'y'.repeat(50) + '_runB').slice(0, 60);
        assert.notStrictEqual(scopedDbName(runA, key), scopedDbName(runB, key));
    });
});

'use strict';

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
 * The pinned mariadb driver ships as a dual package: its package.json
 * declares "type": "module" but its "exports" map a "require" condition
 * to a genuine CommonJS file (dist/promise.cjs). A plain require('mariadb')
 * therefore never invokes Node's require(esm) machinery at all, so the
 * Node 22.12 floor asserted elsewhere in this indexer (where unflagged
 * require(esm) landed) does not apply to loading this driver.
 *
 * This is proven by running require('mariadb') in a child process with
 * --no-experimental-require-module, which disables require(esm) outright.
 * A genuinely ESM-only package fails that the same way (control case
 * below), so a pass here is not vacuous.
 ********************************************************************/

const assert = require('assert');
const cp     = require('child_process');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

describe('Regression: mariadb does not need the Node 22.12 require(esm) floor @regression', function () {
    this.timeout(20000);

    const pkgRoot = path.join(__dirname, '../..');

    it('mariadb resolves via package.json exports "require" condition to a .cjs file', function () {
        const resolved = require.resolve('mariadb', { paths: [pkgRoot] });
        assert.ok(/\.cjs$/.test(resolved),
            'require(\'mariadb\') resolved to "' + resolved + '", not a .cjs file; ' +
            'the dual-package shape this guard relies on may have changed');

        // fs, unlike require(), ignores "exports" restrictions, so this reads
        // the manifest directly rather than tripping ERR_PACKAGE_PATH_NOT_EXPORTED.
        let dir = path.dirname(resolved);
        while (path.basename(dir) !== 'mariadb') {
            const parent = path.dirname(dir);
            assert.notStrictEqual(parent, dir, 'walked to filesystem root without finding a "mariadb" dir');
            dir = parent;
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        assert.strictEqual(manifest.type, 'module',
            'expected mariadb package.json "type": "module" (the ESM-looking half of the dual package)');
        const requireCondition = manifest.exports && manifest.exports['.'] && manifest.exports['.'].require;
        assert.ok(requireCondition, 'mariadb package.json exports["."] has no "require" condition');
        assert.ok(/\.cjs$/.test(requireCondition.default || ''),
            'mariadb exports["."].require.default "' + requireCondition.default + '" is not a .cjs file');
    });

    it("require('mariadb') loads with require(esm) disabled outright", function () {
        const result = cp.spawnSync(process.execPath,
            ['--no-experimental-require-module', '-e', "require('mariadb'); process.exit(0);"],
            { cwd: pkgRoot, encoding: 'utf8' });

        assert.strictEqual(result.status, 0,
            "require('mariadb') failed with require(esm) disabled (status " + result.status + '): ' +
            result.stderr);
        assert.ok(!/ERR_REQUIRE_ESM/.test(result.stderr || ''),
            'require(\'mariadb\') hit ERR_REQUIRE_ESM even though it resolves to a .cjs file: ' +
            result.stderr);
    });

    it('control: a genuinely ESM-only package DOES fail the same way, proving the check above is not vacuous', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-only-control-'));
        try {
            fs.writeFileSync(path.join(dir, 'package.json'),
                JSON.stringify({ name: 'esm-only-control', version: '1.0.0', type: 'module', main: 'index.js' }));
            fs.writeFileSync(path.join(dir, 'index.js'), 'export default 1;\n');

            const result2 = cp.spawnSync(process.execPath,
                ['--no-experimental-require-module', '-e', "require(process.argv[1]);", path.join(dir, 'index.js')],
                { cwd: dir, encoding: 'utf8' });

            assert.notStrictEqual(result2.status, 0,
                'expected an ESM-only, non-dual package to fail require() with require(esm) disabled');
            assert.ok(/ERR_REQUIRE_ESM/.test(result2.stderr || ''),
                'expected ERR_REQUIRE_ESM from the control package, got: ' + result2.stderr);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("require('mariadb') loads on the current runtime (sanity: matches the ledger's live-driver claim)", function () {
        assert.doesNotThrow(() => require('mariadb'));
    });
});

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
 * test/regression/mariadb-runtime-floor.regression.test.js
 *
 * The Node floor the ESM-only mariadb driver imposes.
 *
 * mariadb is pinned at 3.5.2, which declares "type": "module". Node's
 * require() loads ESM without a flag only from 22.12.0; on 22.0 through
 * 22.11 the require at src/db.js throws a bare ERR_REQUIRE_ESM that names
 * neither the runtime nor the reason. engines.node ">=22.0.0 <23" admitted
 * every one of those minors, and neither npm (which only warns, nothing in
 * the tree sets engine-strict) nor .nvmrc (which says only "22") closes it.
 *
 * Two things are guarded here, and they fail independently:
 *
 *   1. engines.node declares a full major.minor floor at or above 22.12.
 *      Asserting the MAJOR alone would stay green on a floor that admits a
 *      dozen failing minors, which is exactly how this shipped.
 *   2. src/db.js asserts the same floor in code, above the require it
 *      protects, so an operator who installed past the npm warning gets a
 *      message naming the version and the fix instead of ERR_REQUIRE_ESM.
 *
 * Ported from the xchain-hub REG-VAL-001 guard, which fixed the same defect
 * on that service first.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

describe('Regression: mariadb ESM runtime floor @regression', function () {

    const pkgPath = path.join(__dirname, '../../package.json');
    const dbPath  = path.join(__dirname, '../../src/db.js');

    it('the pinned mariadb really is the ESM-only line this guard exists for', function () {
        // If mariadb ever ships CommonJS again the floor becomes arbitrary, and this
        // test is where that gets noticed rather than discovered by deleting the guard.
        const dep = require(pkgPath).dependencies.mariadb;
        assert.ok(/^\^?3\.5\./.test(String(dep)), 'expected a mariadb 3.5.x pin, got ' + dep);
    });

    it('engines.node declares a major.minor floor of at least 22.12', function () {
        const engines = require(pkgPath).engines;
        assert.strictEqual(typeof (engines && engines.node), 'string', 'package.json engines.node missing');

        const floor = String(engines.node).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
        assert.notStrictEqual(floor, null,
            'engines.node "' + engines.node + '" must declare a full major.minor floor');

        const major = parseInt(floor[1], 10);
        const minor = parseInt(floor[2], 10);
        assert.ok(major > 22 || (major === 22 && minor >= 12),
            'engines.node "' + engines.node + '" must require Node >= 22.12.0 ' +
            '(unflagged require(esm) landed in 22.12; the mariadb 3.5.x pin is ESM-only)');
    });

    it('engines.node keeps the Node 24 ceiling isolated-vm 5.0.4 needs', function () {
        // Raising the floor must not quietly drop the upper bound: isolated-vm 5.0.4
        // fails node-gyp on Node 24, so a floor-only edit trades a clear boot error
        // for a build failure and admits a runtime the VM cannot be built for.
        const spec = String(require(pkgPath).engines.node);
        assert.ok(/<\s*23/.test(spec), 'engines.node "' + spec + '" lost the "<23" ceiling');
    });

    it('src/db.js asserts the floor in code, above the require it protects', function () {
        const src = fs.readFileSync(dbPath, 'utf8');

        const guardAt   = src.indexOf('NODE_MINOR < 12');
        const requireAt = src.indexOf("require('mariadb')");

        assert.notStrictEqual(guardAt, -1,
            'src/db.js has no Node 22.12 runtime-floor assertion; an operator past the npm ' +
            'engines warning would see a bare ERR_REQUIRE_ESM instead');
        assert.notStrictEqual(requireAt, -1, "src/db.js no longer requires 'mariadb'");
        assert.ok(guardAt < requireAt,
            'the runtime-floor assertion must sit ABOVE require("mariadb"); below it the ' +
            'require throws first and the actionable message never prints');
    });

    it("require('mariadb') loads on the runtime this suite is running", function () {
        assert.doesNotThrow(() => require('mariadb'));
    });
});

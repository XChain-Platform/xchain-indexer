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

const assert = require('assert');
const path   = require('path');

// Guards remediated dependency advisories so a lockfile refresh cannot
// silently resolve back into a known-vulnerable range. npm only re-resolves
// a lock entry when that entry is absent, so an override alone is not enough
// to prove the tree is clean: assert the resolved version too.
describe('Security: remediated dependency advisories @regression @tier4', function () {
    const root = path.resolve(__dirname, '../../../..');
    const pkg  = require(path.join(root, 'package.json'));
    const lock = require(path.join(root, 'package-lock.json'));

    // GHSA-v2hh-gcrm-f6hx: fast-uri host confusion via a literal backslash
    // authority delimiter. Affects >=3.0.0 <=3.1.3; fixed in 3.1.4. Reaches
    // this tree dev-only (xchain-vm -> @stryker-mutator/core -> ajv).
    const advisories = [
        { name: 'fast-uri', minSafe: [3, 1, 4], majorSeries: 3 }
    ];

    // Compares dotted numeric version triples without pulling in semver.
    function cmp(a, b) {
        for (let i = 0; i < 3; i++) {
            if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1;
        }
        return 0;
    }

    function parse(version) {
        return String(version).split('-')[0].split('.').map(Number);
    }

    advisories.forEach(function (adv) {
        const floor = adv.minSafe.join('.');

        it(`ADV-1: package.json pins a ${adv.name} override at or above ${floor}`, function () {
            const range = (pkg.overrides || {})[adv.name];
            assert.ok(range, `expected an overrides entry for ${adv.name}`);
            const pinned = parse(range.replace(/^[^0-9]*/, ''));
            assert.ok(cmp(pinned, adv.minSafe) >= 0,
                `${adv.name} override ${range} is below the patched version ${floor}`);
        });

        it(`ADV-2: every ${adv.name} entry in package-lock.json is at or above ${floor}`, function () {
            const entries = Object.entries(lock.packages)
                .filter(([key]) => key.split('node_modules/').pop() === adv.name);

            // An absent entry is not a pass: it would mean the lock no longer
            // describes a dependency that ajv still requires, and a fresh
            // install would resolve it unguarded.
            assert.ok(entries.length > 0, `no ${adv.name} entry found in package-lock.json`);

            entries.forEach(([key, entry]) => {
                const found = parse(entry.version);
                assert.strictEqual(found[0], adv.majorSeries,
                    `${key} left the ${adv.majorSeries}.x series at ${entry.version}; re-check the advisory range`);
                assert.ok(cmp(found, adv.minSafe) >= 0,
                    `${key} is ${entry.version}, inside the vulnerable range (fixed in ${floor})`);
            });
        });
    });
});

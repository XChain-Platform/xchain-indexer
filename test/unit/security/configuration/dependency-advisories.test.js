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
const fs     = require('fs');
const path   = require('path');

// Guards remediated dependency advisories so a lockfile refresh cannot
// silently resolve back into a known-vulnerable range. npm only re-resolves
// a lock entry when that entry is absent, so an override alone is not enough
// to prove the tree is clean: assert the resolved version too.
describe('Security: remediated dependency advisories @regression @tier4', function () {
    // Located by walking up to the lockfile rather than by a fixed number of
    // '..' hops, so this file stays byte-identical across all the sibling
    // repos that carry it regardless of where each one files its tests.
    const root = (function () {
        let dir = __dirname;
        while (!fs.existsSync(path.join(dir, 'package-lock.json'))) {
            const up = path.dirname(dir);
            if (up === dir) throw new Error(`no package-lock.json above ${__dirname}`);
            dir = up;
        }
        return dir;
    })();
    const pkg  = require(path.join(root, 'package.json'));
    const lock = require(path.join(root, 'package-lock.json'));

    // GHSA-v2hh-gcrm-f6hx: fast-uri host confusion via a literal backslash
    // authority delimiter. Affects >=3.0.0 <=3.1.3; fixed in 3.1.4. Reaches
    // this tree dev-only via ajv.
    //
    // GHSA-mh99-v99m-4gvg (CVE-2026-14257): brace-expansion expand() bounds the
    // number of results but not their total length, so a few KB of chained brace
    // groups exhausts the heap and kills the process with an uncatchable OOM.
    // Affects <=5.0.7 across every release line, and no 1.x/2.x/3.x/4.x carries
    // the patch, so every entry has to move to 5.0.8. Reaches this tree dev-only
    // through minimatch (mocha, glob, stryker, test-exclude).
    //
    // Everything below this point is the second wave: HIGH advisories no
    // lockfile splice could reach, because the safe version was a real upgrade
    // rather than a re-resolve of an already-published patch.
    //
    // axios <1.18.0 carries ten HIGH advisories at once: formDataToJSON
    // recursion DoS, prototype-pollution gadgets in request construction and in
    // Basic-auth subfields, maxBodyLength bypasses on the fetch and HTTP/2
    // adapters, NO_PROXY bypass for 0.0.0.0, proxy inheritance surviving
    // interceptor config cloning, and a form-serializer maxDepth bypass. Unlike
    // the rest of this list axios is a direct runtime dependency of most
    // services, so it is pinned in dependencies rather than through overrides.
    //
    // js-yaml <4.3.0: merge-key ("<<") chains expand quadratically, so a small
    // document forces unbounded CPU. Dev-only here, via mocha's config loader.
    //
    // serialize-javascript <=7.0.4: RCE via RegExp.flags and
    // Date.prototype.toISOString, plus CPU exhaustion on crafted array-likes.
    // Dev-only, via mocha's parallel-run result serialisation.
    //
    // shell-quote <=1.8.4: quadratic-complexity DoS in parse() (CWE-407).
    //
    // form-data <4.0.6: CRLF injection through unescaped multipart field names
    // and filenames, reachable wherever a caller forwards user-supplied names.
    //
    // tmp <0.2.6: path traversal via unsanitised prefix/postfix, plus arbitrary
    // file or directory write through a symlinked `dir`. The 0.0.x line that
    // external-editor pulls in never got the patch, so the whole series has to
    // move onto 0.2.
    const advisories = [
        { name: 'fast-uri', minSafe: [3, 1, 4], majorSeries: 3 },
        { name: 'brace-expansion', minSafe: [5, 0, 8], majorSeries: 5 },
        // Coupled to the entry above: brace-expansion 5.x dropped its CommonJS
        // default export, so only minimatch >=10 (named `import { expand }`)
        // can consume it. Pinning minimatch here keeps the pair from drifting
        // apart into a tree that installs but throws on first glob match.
        { name: 'minimatch', minSafe: [10, 2, 5], majorSeries: 10 },
        { name: 'axios', minSafe: [1, 18, 0], majorSeries: 1 },
        { name: 'js-yaml', minSafe: [4, 3, 0], majorSeries: 4 },
        { name: 'serialize-javascript', minSafe: [7, 0, 5], majorSeries: 7 },
        { name: 'shell-quote', minSafe: [1, 9, 0], majorSeries: 1 },
        { name: 'form-data', minSafe: [4, 0, 6], majorSeries: 4 },
        { name: 'tmp', minSafe: [0, 2, 6], majorSeries: 0 }
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

    // Which of the advisories above are reachable here at all. This file is
    // shared verbatim across siblings whose dependency sets differ, so an
    // advisory for a package this tree never pulls in is genuinely not
    // applicable rather than silently passing.
    function lockEntries(name) {
        return Object.entries(lock.packages)
            .filter(([key]) => key.split('node_modules/').pop() === name);
    }

    // A transitive package is held down by an overrides entry, a direct one by
    // its own dependency range. Either is a real pin, so accept whichever form
    // this repo uses rather than forcing a redundant override next to the
    // declared dependency.
    function pinnedRange(name) {
        return (pkg.overrides || {})[name]
            || (pkg.dependencies || {})[name]
            || (pkg.devDependencies || {})[name];
    }

    advisories.forEach(function (adv) {
        const floor   = adv.minSafe.join('.');
        const present = lockEntries(adv.name).length > 0;

        it(`ADV-1: package.json pins ${adv.name} at or above ${floor}`, function () {
            if (!present) return this.skip();
            const range = pinnedRange(adv.name);
            assert.ok(range,
                `expected ${adv.name} in overrides, dependencies or devDependencies`);
            const pinned = parse(range.replace(/^[^0-9]*/, ''));
            assert.ok(cmp(pinned, adv.minSafe) >= 0,
                `${adv.name} pin ${range} is below the patched version ${floor}`);
        });

        it(`ADV-2: every ${adv.name} entry in package-lock.json is at or above ${floor}`, function () {
            if (!present) return this.skip();
            const entries = lockEntries(adv.name);

            entries.forEach(([key, entry]) => {
                const found = parse(entry.version);
                assert.strictEqual(found[0], adv.majorSeries,
                    `${key} left the ${adv.majorSeries}.x series at ${entry.version}; re-check the advisory range`);
                assert.ok(cmp(found, adv.minSafe) >= 0,
                    `${key} is ${entry.version}, inside the vulnerable range (fixed in ${floor})`);
            });
        });
    });

    // The version pins above are necessary but not sufficient: a minimatch that
    // cannot call the overridden brace-expansion installs quietly and only fails
    // when something actually expands a brace, which in this tree is mocha's own
    // file collector. Exercise the seam so the breakage surfaces here.
    it('ADV-3: minimatch can still brace-expand through the overridden brace-expansion', function () {
        const { minimatch, braceExpand } = require('minimatch');

        assert.deepStrictEqual(braceExpand('{a,b}.js'), ['a.js', 'b.js']);
        assert.strictEqual(minimatch('a.js', '{a,b}.js'), true);
        assert.strictEqual(minimatch('c.js', '{a,b}.js'), false);
    });

    // The fix bounds total expansion length rather than result count alone. This
    // input killed the process outright on <=5.0.7, so reaching the assertion at
    // all is most of the signal; a mocha timeout or a hard exit is the failure.
    it('ADV-4: brace-expansion survives the CVE-2026-14257 unbounded-length input', function () {
        this.timeout(30000);
        const { expand } = require('brace-expansion');

        const expanded = expand('{a,b}'.repeat(1500));
        assert.ok(Array.isArray(expanded) && expanded.length > 0,
            'expected a bounded, truncated result rather than an unbounded expansion');
    });

    // ADV-2 reads the lockfile, which only describes what a fresh install would
    // produce. axios is the one entry here that services load at runtime, so ask
    // the module actually on disk what it is as well: a node_modules left stale
    // by a partial install satisfies every lockfile assertion above.
    it('ADV-5: the installed axios reports a patched runtime version', function () {
        if (!lockEntries('axios').length) return this.skip();
        const axios = require('axios');

        assert.ok(axios.VERSION, 'axios did not expose a VERSION');
        assert.ok(cmp(parse(axios.VERSION), [1, 18, 0]) >= 0,
            `installed axios is ${axios.VERSION}, inside the vulnerable range (fixed in 1.18.0)`);
    });
});

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

// Companion to dependency-advisories.test.js, and deliberately a separate file:
// that one is byte-identical across every sibling repo that carries it and
// describes what a fresh install WOULD resolve, while this hazard lives in the
// part of the lockfile a fresh install does not re-resolve.
//
// This repo depends on xchain-vm as a local path (file:./xchain-vm). The
// directory is gitignored and staged at build time from the canonical sibling,
// so npm links it rather than fetching it, and package-lock.json records a
// FROZEN COPY of that staged manifest under its path key. Nothing reconciles
// that copy afterwards: npm only rewrites it when a staged package.json is
// present at install time, so on every checkout that does not stage one the
// snapshot simply persists. It rots silently, because nothing resolves
// differently while the pinned ranges still agree.
//
// That is benign right up until it is not. The snapshot carries the bundled
// package's own dependency ranges, so a stale one can hold a nested copy at a
// version a root-level security bump believes it already replaced, and the
// mismatch is invisible in `npm ls`. The same rot has been found here twice:
// this repo's snapshot froze at a version the VM had long since renumbered
// past, exactly as xchain-e2e-test's ADV-9 guard caught for its own staged
// siblings (test/unit/security/configuration/sibling-tree-advisories.test.js).
// This is that guard, ported.
describe('Security: bundled sibling lockfile snapshots @regression @tier4', function () {
    // Located by walking up to the lockfile rather than by a fixed number of
    // '..' hops, so this file stays byte-identical across the sibling repos
    // that carry it regardless of where each one files its tests.
    const root = (function () {
        let dir = __dirname;
        while (!fs.existsSync(path.join(dir, 'package-lock.json'))) {
            const up = path.dirname(dir);
            if (up === dir) throw new Error(`no package-lock.json above ${__dirname}`);
            dir = up;
        }
        return dir;
    })();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    // Every dependency declared as a local path, in whichever section it is
    // declared: the indexer bundles the VM as a hard dependency, the explorer
    // as an optional one, and a third bundled sibling is covered the day it is
    // added rather than the day someone remembers this file.
    function bundledSiblings() {
        const sections = ['dependencies', 'optionalDependencies', 'devDependencies'];
        const seen = new Map();
        for (const section of sections) {
            for (const [name, range] of Object.entries(pkg[section] || {})) {
                if (!/^file:/.test(String(range)) || seen.has(name)) continue;
                seen.set(name, {
                    name,
                    dir: path.resolve(root, String(range).replace(/^file:/, ''))
                });
            }
        }
        return [...seen.values()];
    }

    // Source of truth, in the two places the sibling can actually be, canonical
    // first. bin/vendor-vm.sh treats the checkout BESIDE this repo as canonical
    // and its `check` mode fails closed on any byte drift between that and the
    // staged copy, so preferring it here keeps the two guards pointed at the
    // same version rather than at each other. The staged copy is the fallback
    // for a standalone checkout that has no sibling beside it.
    function truthManifest(sibling) {
        const candidates = [
            path.join(root, '..', path.basename(sibling.dir), 'package.json'),
            path.join(sibling.dir, 'package.json')
        ];
        const found = candidates.find(p => fs.existsSync(p));
        return found ? { file: found, manifest: JSON.parse(fs.readFileSync(found, 'utf8')) } : null;
    }

    it('SNAP-1: package.json still declares the bundled siblings as local paths', function () {
        // Guards the premise rather than the hazard: if these stop being file:
        // dependencies the per-sibling cases below silently cover nothing, and
        // this suite would pass while proving less than it did yesterday.
        assert.ok(bundledSiblings().length > 0,
            'expected at least one file: dependency (xchain-vm); the bundling layout changed '
            + 'and this guard needs re-pointing');
    });

    bundledSiblings().forEach(function (sibling) {
        it(`SNAP-2: the lockfile snapshot of ${sibling.name} records the version the sibling carries`, function () {
            const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
            const key  = path.relative(root, sibling.dir).split(path.sep).join('/');
            const snap = (lock.packages || {})[key];

            assert.ok(snap, `package-lock.json has no packages["${key}"] entry for the bundled `
                + `${sibling.name}; the file: dependency layout changed and this guard needs re-pointing`);
            assert.ok(typeof snap.version === 'string',
                `package-lock.json packages["${key}"] records no version for ${sibling.name}`);

            const truth = truthManifest(sibling);
            if (!truth) {
                // Neither layout is present, so there is nothing to compare
                // against. A drift-guard context sets XCHAIN_REQUIRE_SIBLINGS
                // on purpose (bin/ci-all.sh, the CI drift-guards job), and a
                // skip there would be a green-by-absence, so fail closed.
                assert.ok(!process.env.XCHAIN_REQUIRE_SIBLINGS,
                    `no ${sibling.name} manifest beside or inside this repo and XCHAIN_REQUIRE_SIBLINGS `
                    + 'is set; refusing to skip');
                return this.skip();
            }

            assert.strictEqual(snap.version, truth.manifest.version,
                `package-lock.json packages["${key}"] records ${sibling.name}@${snap.version}, but `
                + `${path.relative(root, truth.file)} declares ${truth.manifest.version}. The bundled `
                + 'snapshot is frozen at a version the sibling no longer carries, so the nested ranges '
                + 'it pins are equally frozen. Re-stage the sibling (npm run vendor:vm) and regenerate '
                + 'the lockfile, or correct the version field when the tree cannot be re-staged here.');
        });

        it(`SNAP-3: the lockfile snapshot of ${sibling.name} records the dependency ranges the sibling declares`, function () {
            // The version field is the tell, but the pinned ranges are the
            // hazard: those are what decide which nested copies an install
            // materialises, and a snapshot can carry stale ranges under a
            // corrected version if someone patches only the field this suite's
            // previous case names.
            const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
            const key  = path.relative(root, sibling.dir).split(path.sep).join('/');
            const snap = (lock.packages || {})[key];
            assert.ok(snap, `package-lock.json has no packages["${key}"] entry for the bundled ${sibling.name}`);

            const truth = truthManifest(sibling);
            if (!truth) {
                assert.ok(!process.env.XCHAIN_REQUIRE_SIBLINGS,
                    `no ${sibling.name} manifest beside or inside this repo and XCHAIN_REQUIRE_SIBLINGS `
                    + 'is set; refusing to skip');
                return this.skip();
            }

            assert.deepStrictEqual(snap.dependencies || {}, truth.manifest.dependencies || {},
                `package-lock.json packages["${key}"] pins dependency ranges for ${sibling.name} that `
                + `${path.relative(root, truth.file)} no longer declares. A frozen range here can hold a `
                + 'nested copy at a version a root-level security bump believes it replaced. Re-stage the '
                + 'sibling (npm run vendor:vm) and regenerate the lockfile.');
        });
    });
});

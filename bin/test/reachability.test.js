/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The reachability sweep and the sibling reference map, driven against the real
 * tree rather than a fixture. The verdicts these two produce decide what the
 * restructure deletes, so the assertions are about files whose status is
 * independently known: src/api.js runs in the container, src/db.js is required
 * transitively from it, and a module reached only from its own suite is not.
 *
 * This suite is outside test/ on purpose: every npm test script globs from
 * test/, and the pass pins those scripts' collected titles. Run it directly:
 *
 *   npx mocha --no-config --timeout 120000 bin/test/reachability.test.js
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');

const reach = require('../reachability.js');
const refs  = require('../sibling-reference-map.js');

const SIBLINGS_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('bin/reachability.js', function () {
    this.timeout(120000);

    describe('entry point discovery', () => {
        it('finds the container command and the migrate script as runtime entry points', () => {
            const report = reach.analyse({ siblings: false });
            assert.ok(report.summary.runtimeEntryPoints.includes('src/api.js'),
                'the Dockerfile CMD must be an entry point');
            assert.ok(report.summary.runtimeEntryPoints.includes('src/migrate.js'),
                'npm run migrate starts a node process and is a runtime path');
        });

        it('resolves a relative require to the file it loads, extension or not', () => {
            assert.strictEqual(reach.resolveRequire('src/api.js', './db.js'), 'src/db.js');
            assert.strictEqual(reach.resolveRequire('src/api.js', './db'), 'src/db.js');
            assert.strictEqual(reach.resolveRequire('src/api.js', './coins'), 'src/coins/index.js');
            assert.strictEqual(reach.resolveRequire('src/api.js', 'mariadb'), null,
                'a package is not a repo-local edge');
        });
    });

    describe('the runtime closure', () => {
        const report = reach.analyse({ siblings: false });

        it('carries a transitively required module, not just the direct ones', () => {
            assert.strictEqual(report.files['src/db.js'].reachableFromIndexerRuntime, true);
            assert.strictEqual(report.files['src/actions/send.js'].reachableFromIndexerRuntime, true);
        });

        it('applies the declared dynamic edges the static walk cannot see', () => {
            // configs/BTC.js has no literal requirer: config.js builds the path.
            assert.strictEqual(report.files['src/configs/BTC.js'].reachableFromIndexerRuntime, true,
                'the per-coin config is required by a computed path and is on the boot path');
        });

        it('does not count a module reached only from its own suite', () => {
            const gate = report.files['src/reward-push-gate.js'];
            assert.strictEqual(gate.reachableFromIndexerRuntime, false);
            assert.strictEqual(gate.reachableFromTooling, false);
            assert.strictEqual(gate.testOnly, true);
        });

        it('keeps a module whose only caller is a kept non-runtime file', () => {
            const history = report.files['src/capability_min_stake_history.js'];
            assert.strictEqual(history.reachableFromIndexerRuntime, false);
            assert.deepStrictEqual(history.requiredByInRepo, ['src/recovery.js']);
        });
    });

    describe('the cross-repo verdict', () => {
        const report = reach.analyse({ siblings: true, siblingsRoot: SIBLINGS_ROOT });

        it('clears a file another repo keeps a maintained copy of', () => {
            const price = report.files['src/xchainPrice.js'];
            assert.strictEqual(price.reachableFromIndexerRuntime, false);
            assert.ok(price.twinCopies.length > 0 || price.referencedBySiblings.length > 0,
                'a twinned module is held by the platform even with no runtime path here');
            assert.strictEqual(price.unreferencedAcrossPlatform, false);
        });

        it('condemns only what nothing on the platform holds', () => {
            const orphans = Object.keys(report.files)
                .filter((f) => report.files[f].unreferencedAcrossPlatform);
            assert.deepStrictEqual(orphans, ['src/reward-push-gate.js']);
        });
    });
});

describe('bin/sibling-reference-map.js', function () {
    this.timeout(120000);

    it('reads a literal path segment list and stops at an expression', () => {
        assert.strictEqual(refs.literalJoinTail(" 'coins', 'BTC.js')"), 'coins/BTC.js');
        assert.strictEqual(refs.literalJoinTail(' rel)'), null);
        assert.strictEqual(refs.literalJoinTail(" 'coins', coin + '.js')"), null);
    });

    it('drops the punctuation a prose mention leaves on a path', () => {
        assert.strictEqual(refs.trimPath('src/utility.js'), 'src/utility.js');
        assert.strictEqual(refs.trimPath("src/utility.js'"), 'src/utility.js');
        assert.strictEqual(refs.trimPath('src/utility.js).'), 'src/utility.js');
    });

    it('resolves a reference written without its extension', () => {
        assert.strictEqual(refs.resolveInRepo('src/hub_db_sync'), 'src/hub_db_sync.js');
        assert.strictEqual(refs.resolveInRepo('src/does_not_exist.js'), null);
    });

    it('finds the load sites a sibling suite uses to reach into this repo', () => {
        const map = refs.buildReferenceMap(SIBLINGS_ROOT);
        assert.ok(map.siblingRepos.length >= 5, 'the sweep must see the sibling checkouts');
        assert.ok(!map.siblingRepos.includes('xchain-indexer'), 'a repo is not its own sibling');
        const utility = map.paths['src/utility.js'];
        assert.ok(utility, 'src/utility.js is required by name from sibling suites');
        assert.ok(utility.referrers.some((r) => r.kind === 'require'),
            'at least one sibling loads it rather than merely naming it');
    });
});

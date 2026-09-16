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
 * independently known: src/api.js runs in the container, src/db/index.js is
 * required transitively from it, and a module reached only from its own suite
 * is not.
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
            assert.ok(report.summary.runtimeEntryPoints.includes('src/db/migration/migrate.js'),
                'npm run migrate starts a node process and is a runtime path');
        });

        it('resolves a relative require to the file it loads, extension or not', () => {
            assert.strictEqual(reach.resolveRequire('src/api.js', './utility.js'), 'src/utility.js');
            assert.strictEqual(reach.resolveRequire('src/api.js', './utility'), 'src/utility.js');
            assert.strictEqual(reach.resolveRequire('src/api.js', './db'), 'src/db/index.js',
                'a directory require loads its index.js, which is how every reader reaches the database');
            assert.strictEqual(reach.resolveRequire('src/api.js', './coins'), 'src/coins/index.js');
            assert.strictEqual(reach.resolveRequire('src/api.js', 'mariadb'), null,
                'a package is not a repo-local edge');
        });
    });

    describe('the runtime closure', () => {
        const report = reach.analyse({ siblings: false });

        it('carries a transitively required module, not just the direct ones', () => {
            assert.strictEqual(report.files['src/db/index.js'].reachableFromIndexerRuntime, true);
            assert.strictEqual(report.files['src/actions/send/index.js'].reachableFromIndexerRuntime, true);
        });

        it('carries the database mixins the install loop requires by computed path', () => {
            // Nothing in src/db/index.js names a mixin as a literal, so withdrawing
            // the declared edge drops all three assertions at once and every mixin
            // reads unreferenced across the platform.
            const mixin = report.files['src/db/sends/index.js'];
            assert.deepStrictEqual(mixin.requiredByInRepo, ['src/db/index.js'],
                'a mixin is held by the install loop and by nothing else');
            assert.strictEqual(mixin.reachableFromIndexerRuntime, true,
                'a mixin is on the boot path through the database module');
            const unheld = Object.keys(report.files)
                .filter((f) => f.startsWith('src/db/') && !report.files[f].reachableFromIndexerRuntime);
            // The one exception is the XCHAIN price SQL: it sits under src/db/ because
            // that is where SQL lives, but its only caller here is the price query
            // module, which the indexer itself never boots (the HUB derives the price,
            // from its byte-identical vendored copies of both files), so it is held by
            // the query module's suite and by the sibling sweep, never by the runtime.
            assert.deepStrictEqual(unheld, ['src/db/price/xchain_price_query_sql.js'],
                'every file under src/db/ but the vendored price SQL is reached from the runtime');
        });

        it('applies the declared dynamic edges the static walk cannot see', () => {
            // No literal names this gate carrier: the digest builds
            // './<module>.js' from its SHARED_GATES rows, so withdrawing the
            // declared edge drops both assertions below at once.
            const gate = report.files['src/checkpoint_commitment_activation.js'];
            assert.deepStrictEqual(gate.requiredByInRepo, ['src/consensus_rules_digest.js'],
                'the gate carrier is held by the computed require and by nothing else');
            assert.strictEqual(gate.reachableFromIndexerRuntime, true,
                'a SHARED_GATES carrier is on the boot path through the digest');
        });

        it('does not count a module reached only from its own suite', () => {
            // The utf8mb4 column helper is a module only a suite holds: nothing
            // on the runtime or tooling path requires it.
            const columns = report.files['src/chain/utf8mb4_columns.js'];
            assert.strictEqual(columns.reachableFromIndexerRuntime, false);
            assert.strictEqual(columns.reachableFromTooling, false);
            assert.strictEqual(columns.testOnly, true);
        });

        it('keeps a module whose only caller is a kept non-runtime file', () => {
            const history = report.files['src/consensus/capability_min_stake_history.js'];
            assert.strictEqual(history.reachableFromIndexerRuntime, false);
            assert.deepStrictEqual(history.requiredByInRepo, ['bin/recovery.js']);
        });

        it('reaches every gate module W4 moved into a feature directory from the runtime', () => {
            // The ten logic-bearing activation modules kept their bodies and moved
            // beside their callers; a move that broke a require would read here as
            // an unreached module, not as a failing action test somewhere else.
            const moved = Object.keys(report.files).filter((f) => /^src\/.+\/[a-z0-9_]+_gate\.js$/.test(f)
                && f !== 'src/api/auth_gate.js' && f !== 'src/XChainIndexer/train_gate.js');
            assert.strictEqual(moved.length, 10, 'the W4 census: ten moved gate modules, found ' + moved.join(', '));
            for (const f of moved) assert.strictEqual(report.files[f].reachableFromIndexerRuntime, true, f + ' is not on the runtime path');
        });
    });

    describe('the cross-repo verdict', () => {
        const report = reach.analyse({ siblings: true, siblingsRoot: SIBLINGS_ROOT });

        it('clears a file another repo keeps a maintained copy of', () => {
            const price = report.files['src/consensus/xchain_price.js'];
            assert.strictEqual(price.reachableFromIndexerRuntime, false);
            assert.ok(price.twinCopies.length > 0 || price.referencedBySiblings.length > 0,
                'a twinned module is held by the platform even with no runtime path here');
            assert.strictEqual(price.unreferencedAcrossPlatform, false);
        });

        it('condemns only what nothing on the platform holds', () => {
            const orphans = Object.keys(report.files)
                .filter((f) => report.files[f].unreferencedAcrossPlatform);
            assert.deepStrictEqual(orphans, []);

            // NEGATIVE CONTROL, and the reason an empty list above is a result
            // rather than a silence. Every remaining candidate is cleared by the
            // sibling sweep alone, so the same predicate over the same tree must
            // still condemn when that sweep is withheld. Without this half a
            // detector that had stopped computing the flag would read identically.
            const local = reach.analyse({ siblings: false });
            const withheld = Object.keys(local.files)
                .filter((f) => local.files[f].unreferencedAcrossPlatform);
            // Path order, not an arbitrary list: the verdict is keyed by sorted
            // path, so moving a module into a feature directory moves its row.
            assert.deepStrictEqual(withheld, [
                'src/chain/utf8mb4_columns.js',
                'src/consensus/xchain_price.js',
                'src/consensus/xchain_price_query.js',
            ], 'the three test-only modules are candidates that only the sibling sweep clears');
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
        assert.strictEqual(refs.resolveInRepo('src/hub/hub_db_sync'), 'src/hub/hub_db_sync.js');
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

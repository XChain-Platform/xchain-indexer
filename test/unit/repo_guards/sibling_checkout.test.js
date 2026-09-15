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
 * The sibling-checkout verdict, driven against real git shapes.
 *
 * The helper's answer depends on whether `.git` is a file or a directory and
 * on whether a sibling entry is a symlink, so a fixture without real git
 * metadata cannot exercise it (a directory with no `.git` answers for the
 * enclosing repo instead). Every cell below builds the layout it names in a
 * temporary directory with the git binary: a developer's main checkouts, a
 * CI venue's plain clones, `--shared` clones, and the lane layout of a linked
 * worktree beside symlinks. One cell per branch of the helper, so breaking any
 * one branch reddens its own cell.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

// Fixture repos live and die in the OS temp directory and are never pushed, so
// they carry a throwaway identity through the environment. Hooks and signing
// are switched off per command so a developer's global git config cannot turn
// a fixture commit into a pinentry prompt or a hook run.
const FIXTURE_ENV = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: 'sibling-fixture', GIT_AUTHOR_EMAIL: 'sibling-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'sibling-fixture', GIT_COMMITTER_EMAIL: 'sibling-fixture@example.invalid',
});

function git(cwd, ...args) {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
        { cwd, env: FIXTURE_ENV, stdio: 'pipe' }).toString();
}

/** A main checkout with one committed file, so clones and worktrees have something to carry. */
function makeRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'f.js'), 'module.exports = 1;\n');
    git(dir, 'add', 'f.js');
    git(dir, 'commit', '-q', '-m', 'fixture');
}

let T;

function setupLayouts() {
    T = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-checkout-'));
    makeRepo(path.join(T, 'main', 'xchain-own'));
    makeRepo(path.join(T, 'main', 'xchain-sib'));
}

function cleanupLayouts() {
    if (T) fs.rmSync(T, { recursive: true, force: true });
}

const judge = (ownRoot, target) => siblingCheckout(ownRoot, target, { ownRoot });

describe('sibling_checkout verdict against real git layouts', function () {
    this.timeout(30000);
    before(setupLayouts);
    after(cleanupLayouts);

    it('trusts a real sibling directory beside a main checkout', function () {
        const v = judge(path.join(T, 'main', 'xchain-own'), '../xchain-sib/f.js');
        assert.strictEqual(v.usable, true, v.reason);
    });

    it('refuses a missing sibling', function () {
        const v = judge(path.join(T, 'main', 'xchain-own'), '../xchain-none/f.js');
        assert.strictEqual(v.usable, false);
        assert.match(v.reason, /absent/);
    });

    it('refuses a linked worktree reading a symlink into a live main checkout', function () {
        const own = path.join(T, 'lane', 'xchain-own');
        git(path.join(T, 'main', 'xchain-own'), 'worktree', 'add', '-q', '--detach', own);
        fs.symlinkSync('../main/xchain-sib', path.join(T, 'lane', 'xchain-sib'));
        const v = judge(own, '../xchain-sib/f.js');
        assert.strictEqual(v.usable, false);
        assert.match(v.reason, /symlink into the live main checkout/);
    });

    it('trusts plain clones laid side by side, as a CI venue lays them', function () {
        git(T, 'clone', '-q', path.join(T, 'main', 'xchain-own'), path.join(T, 'venue', 'xchain-own'));
        git(T, 'clone', '-q', path.join(T, 'main', 'xchain-sib'), path.join(T, 'venue', 'xchain-sib'));
        const v = judge(path.join(T, 'venue', 'xchain-own'), '../xchain-sib/f.js');
        assert.strictEqual(v.usable, true, v.reason);
    });

});

describe('sibling_checkout verdict against real git layouts', function () {
    this.timeout(30000);
    before(setupLayouts);
    after(cleanupLayouts);

    it('trusts --shared clones laid side by side', function () {
        git(T, 'clone', '-q', '--shared', path.join(T, 'main', 'xchain-own'), path.join(T, 'shared', 'xchain-own'));
        git(T, 'clone', '-q', '--shared', path.join(T, 'main', 'xchain-sib'), path.join(T, 'shared', 'xchain-sib'));
        const v = judge(path.join(T, 'shared', 'xchain-own'), '../xchain-sib/f.js');
        assert.strictEqual(v.usable, true, v.reason);
    });

    it('trusts a linked worktree reading a symlink into another linked worktree', function () {
        const own = path.join(T, 'lane2', 'xchain-own');
        git(path.join(T, 'main', 'xchain-own'), 'worktree', 'add', '-q', '--detach', own);
        git(path.join(T, 'main', 'xchain-sib'), 'worktree', 'add', '-q', '--detach', path.join(T, 'wt', 'xchain-sib'));
        fs.symlinkSync('../wt/xchain-sib', path.join(T, 'lane2', 'xchain-sib'));
        const v = judge(own, '../xchain-sib/f.js');
        assert.strictEqual(v.usable, true, v.reason);
    });

    it('trusts a linked worktree beside a real sibling checkout directory', function () {
        const own = path.join(T, 'lane3', 'xchain-own');
        git(path.join(T, 'main', 'xchain-own'), 'worktree', 'add', '-q', '--detach', own);
        makeRepo(path.join(T, 'lane3', 'xchain-sib'));
        const v = judge(own, '../xchain-sib/f.js');
        assert.strictEqual(v.usable, true, v.reason);
    });

    it('trusts a path that is not a sibling of the checkout at all', function () {
        const own = path.join(T, 'lane', 'xchain-own');
        const outside = path.join(T, 'outside.js');
        fs.writeFileSync(outside, '\n');
        const v = judge(own, outside);
        assert.strictEqual(v.usable, true, v.reason);
    });
});

describe('sibling_checkout skipOrFail', function () {
    const refused = { usable: false, path: '/x', reason: 'sibling path absent: /x' };
    let saved;
    beforeEach(function () { saved = process.env.XCHAIN_REQUIRE_SIBLINGS; });
    afterEach(function () {
        if (saved === undefined) delete process.env.XCHAIN_REQUIRE_SIBLINGS;
        else process.env.XCHAIN_REQUIRE_SIBLINGS = saved;
    });

    it('skips a refused sibling in soft mode', function () {
        delete process.env.XCHAIN_REQUIRE_SIBLINGS;
        let skipped = false;
        skipOrFail({ skip() { skipped = true; } }, refused, 'the fixture guard');
        assert.strictEqual(skipped, true);
    });

    it('fails a refused sibling naming the reason when siblings were declared supplied', function () {
        process.env.XCHAIN_REQUIRE_SIBLINGS = '1';
        assert.throws(() => skipOrFail({ skip() {} }, refused, 'the fixture guard'),
            /XCHAIN_REQUIRE_SIBLINGS=1 but the fixture guard cannot run: sibling path absent/);
    });

    it('lets a usable sibling through without skipping', function () {
        let skipped = false;
        const ok = skipOrFail({ skip() { skipped = true; } }, { usable: true, path: '/x', reason: null }, 'g');
        assert.strictEqual(ok, true);
        assert.strictEqual(skipped, false);
    });
});

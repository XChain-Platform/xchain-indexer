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
 * May a cross-repo guard trust the sibling file it is about to read?
 *
 * The guards in this tree reach a sibling repo as `../../../xchain-<name>`,
 * which is only a statement about the directory layout, not about which
 * commit of the sibling is sitting there. Two layouts give an honest answer:
 * a main checkout beside its sibling main checkouts (a developer's tree), and
 * a CI venue, which clones every declared sibling as a real directory beside
 * the repo under test. A third layout gives a dishonest one: a linked worktree
 * cut under a lane directory whose `xchain-<name>` entries are SYMLINKS into
 * the platform's main checkouts. There the path resolves into a peer
 * session's live working tree, uncommitted edits and all, and a guard reads
 * green against state no commit holds. On 2026-09-14 a cross-lineage
 * falsification returned a false pass for exactly that reason.
 *
 * So a sibling is refused when it is absent, and also when this checkout is a
 * linked worktree and the sibling entry beside it is a symlink whose target is
 * a main checkout (its `.git` is a directory). A symlink into another linked
 * worktree is allowed: that is a deliberately cut tree at a known ref.
 *
 * The verdict never decides soft versus strict on its own. Guards skip on a
 * refusal in soft mode and fail naming the reason when the run declared its
 * siblings supplied with XCHAIN_REQUIRE_SIBLINGS=1, which is what skipOrFail()
 * does. Guards keep their own path literals, so every census that greps for
 * `xchain-<name>/...` still sees what each guard reads.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const OWN_ROOT = path.resolve(__dirname, '..', '..');

/** True when the sibling checkouts were declared supplied for this run. */
function siblingsRequired(env = process.env) {
    return env.XCHAIN_REQUIRE_SIBLINGS === '1';
}

/** A linked worktree carries a `.git` FILE pointing at its common dir. */
function isLinkedWorktree(root) {
    try { return fs.lstatSync(path.join(root, '.git')).isFile(); }
    catch (e) { return false; }
}

/** The nearest ancestor of `dir` (inclusive) that holds a `.git` entry, or null. */
function checkoutRootOf(dir) {
    for (let d = dir; ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, '.git'))) return d;
        if (path.dirname(d) === d) return null;
    }
}

/**
 * Judge one sibling path.
 *
 * @param {string} fromDir   the directory the guard's literal is relative to (its __dirname)
 * @param {string} target    the guard's own path literal, relative or absolute
 * @param {object} [opts]
 * @param {string} [opts.ownRoot]  the checkout the guard runs in; defaults to this repo
 * @returns {{usable: boolean, path: string, reason: string|null}}
 */
function siblingCheckout(fromDir, target, opts = {}) {
    const ownRoot = opts.ownRoot || OWN_ROOT;
    const abs = path.resolve(fromDir, target);

    if (!fs.existsSync(abs))
        return { usable: false, path: abs, reason: 'sibling path absent: ' + abs };

    // Only the entry directly beside this checkout can be the lane symlink. A
    // path that does not pass through that parent is not a sibling reference.
    const parent = path.dirname(ownRoot);
    const rel = path.relative(parent, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel))
        return { usable: true, path: abs, reason: null };
    const entry = path.join(parent, rel.split(path.sep)[0]);

    if (!isLinkedWorktree(ownRoot) || !fs.lstatSync(entry).isSymbolicLink())
        return { usable: true, path: abs, reason: null };

    const real = fs.realpathSync(entry);
    const targetRoot = checkoutRootOf(real);
    const targetIsMain = targetRoot !== null
        && fs.lstatSync(path.join(targetRoot, '.git')).isDirectory();
    if (targetIsMain)
        return {
            usable: false, path: abs,
            reason: 'sibling ' + path.basename(entry) + ' resolves through a symlink into the live main checkout '
                + targetRoot + ', which no commit pins; cut a real sibling worktree to test against it',
        };
    return { usable: true, path: abs, reason: null };
}

/**
 * Act on a refusal inside a mocha test or hook: fail when siblings were
 * declared supplied, otherwise skip. Returns false so a caller can write
 * `if (!verdict.usable) return skipOrFail(this, verdict, 'what this guard checks');`.
 *
 * @param {object} ctx      the mocha `this`
 * @param {{usable: boolean, reason: string|null}} verdict  from siblingCheckout()
 * @param {string} what     one clause naming the guard, for the failure message
 */
function skipOrFail(ctx, verdict, what) {
    if (verdict.usable) return true;
    if (siblingsRequired())
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + what + ' cannot run: ' + verdict.reason);
    ctx.skip();
    return false;
}

module.exports = { siblingCheckout, skipOrFail, siblingsRequired, isLinkedWorktree };

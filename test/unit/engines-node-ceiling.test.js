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

// : engines.node must keep an upper bound below Node 23.
//
// The indexer installs xchain-vm through `file:./xchain-vm`, and that package
// depends on isolated-vm 5.0.4, whose native binding node-gyp cannot build on
// Node 24 (it uses `T::IsStackAllocatedTypeMarker`, a V8 API that major
// removed). A clean build probe compiles and loads on 22.22.3 and fails on
// 24.15.0, so the bound is measured rather than stylistic.
//
// A range of ">=22.0.0" ADMITS 24: `npm install` proceeds normally right up
// to the compile failure. The cross-repo sweep lives in the platform gate
// (bin/check-node-engine-ceiling.js), which per-repo GitHub CI never runs;
// this guard is what covers THIS package.json in THIS repo's own suite.

const assert = require('assert');
const pkg = require('../../package.json');

/** The exclusive upper bound a single npm comparator implies, or null. */
function comparatorCeiling(token) {
    const parse = (raw) => {
        const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(String(raw).trim());
        if (!m) return null;
        const num = (s) => (s === undefined || s === 'x' || s === '*' ? 0 : Number(s));
        return [Number(m[1]), num(m[2]), num(m[3])];
    };
    const t = token.trim();
    let m = /^<=(.+)$/.exec(t);
    if (m) { const v = parse(m[1]); return v && [v[0], v[1], v[2] + 1]; }
    m = /^<(.+)$/.exec(t);
    if (m) return parse(m[1]);
    if (/^(>=?|\*)/.test(t)) return null;
    m = /^\^(.+)$/.exec(t);
    if (m) { const v = parse(m[1]); return v && [v[0] + 1, 0, 0]; }
    m = /^~(.+)$/.exec(t);
    if (m) { const v = parse(m[1]); return v && [v[0], v[1] + 1, 0]; }
    m = /^=?(\d+)(\.[x*])?$/.exec(t);
    if (m) return [Number(m[1]) + 1, 0, 0];
    return null;
}

const lte = (a, b) => a[0] !== b[0] ? a[0] < b[0]
    : a[1] !== b[1] ? a[1] < b[1]
        : a[2] <= b[2];

/** True only when EVERY `||` alternative is bounded at or below 23.0.0. */
function boundedBelow23(range) {
    if (typeof range !== 'string' || !range.trim()) return false;
    return range.split('||').every((alt) =>
        alt.trim().split(/\s+/).map(comparatorCeiling).filter(Boolean)
            .some((c) => lte(c, [23, 0, 0])));
}

describe('packaging: engines.node ceiling ', function () {
    const allDeps = Object.assign({}, pkg.dependencies, pkg.optionalDependencies, pkg.devDependencies);

    it('still links xchain-vm, so the ceiling is still load-bearing', function () {
        // If this ever fails, the isolated-vm reach is gone: re-derive the
        // ceiling from what remains, do not just widen it.
        assert.ok(allDeps['xchain-vm'],
            'xchain-vm is no longer a dependency; revisit the engines ceiling');
    });

    it('excludes Node 23 and above', function () {
        const range = pkg.engines && pkg.engines.node;
        assert.ok(boundedBelow23(range),
            `engines.node="${range}" admits Node 23+, where isolated-vm cannot build. Use ">=22.0.0 <23".`);
    });

    it('still admits the pinned canonical runtime (.nvmrc: Node 22)', function () {
        const range = pkg.engines.node;
        assert.ok(/(^|\s)>=\s*22(\.|\s|$)/.test(range),
            `engines.node="${range}" no longer states the Node 22 floor the node:22-bookworm image runs`);
    });

    it('keeps a written reason next to the ceiling', function () {
        // The bound looks arbitrary six months from now; the comment is what
        // stops the next reader from "modernising" it back to open-ended.
        assert.match(String(pkg.engines.comment || ''), /isolated-vm/i,
            'engines.comment should say why the range is capped');
    });
});

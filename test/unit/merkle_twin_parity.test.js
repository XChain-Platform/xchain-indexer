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
 * src/consensus/merkle.js is carried byte-identically by four repos, and nothing
 * enforced that.
 *
 * The indexer commits block_merkle_root with this module; the explorer proof
 * server locates a row's leaf index with it; sync re-derives roots with it;
 * the SDK verifies proofs with it. Leaf order and leaf preimage are
 * position-defined by this file, so a one-sided edit does not fail loudly, it
 * splits commit from proof: the indexer commits one root while the proof
 * server builds inclusion proofs against a different leaf vector.
 *
 * Every copy was byte-identical when this gate was written, and each repo's
 * own suites pin behaviour against ITSELF only, which is exactly the shape
 * that drifts silently (the same reasoning as consensus_params.test.js for
 * the CONTROLLER_GUARD constants and xcall_constants_cross_repo.test.js for
 * the XCALL/VM constants). Found while costing, which had to touch all
 * four copies; the gate is route-independent and outlives that item's fix.
 *
 * Skips where fewer than two carriers are on disk (standalone checkout); in
 * the monorepo and in bin/ci-all.sh all four are present.
 **********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Each carrier names its OWN src-relative path, because the feature directories are
// an xchain-indexer layout: the canonical sits under consensus/ here while the three
// vendored copies stay flat. One shared path would silently drop the canonical out of
// the comparison, leaving the three siblings agreeing with each other while the file
// this repo actually commits roots with went unchecked.
const CARRIERS = [
    ['xchain-indexer',  'consensus/merkle.js'],
    ['xchain-explorer', 'merkle.js'],
    ['xchain-sync',     'merkle.js'],
    ['xchain-sdk',      'merkle.js'],
];

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('src/consensus/merkle.js is byte-identical across its four carriers', function () {

    it('this repo carries the module at all', function () {
        assert.strictEqual(fs.existsSync(path.resolve(__dirname, '..', '..', 'src', 'consensus', 'merkle.js')), true);
    });

    it('every carrier present on disk has the same bytes', function () {
        const root = path.resolve(__dirname, '..', '..', '..');
        const found = [];
        for (const [repo, rel] of CARRIERS) {
            const p = path.join(root, repo, 'src', rel);
            if (fs.existsSync(p)) found.push([repo + '/src/' + rel, sha256File(p)]);
        }
        // This repo's own copy is never optional: it is the canonical the others are
        // vendored from, so a path that stopped resolving here has to fail rather than
        // leave the siblings comparing against each other.
        assert.ok(found.some(([label]) => label.startsWith('xchain-indexer/')),
            'the canonical copy did not resolve; repoint CARRIERS at its current path');
        // Fewer than two carriers means the siblings are not checked out next to
        // this repo; the pin above still runs, so a standalone CI lane is not
        // silently toothless, it just cannot compare.
        if (found.length < 2) return this.skip();

        const [baseRepo, expected] = found[0];
        for (const [repo, digest] of found) {
            assert.strictEqual(digest, expected,
                `${repo} (${digest.slice(0, 16)}) differs from ${baseRepo} (${expected.slice(0, 16)}); `
                + 'merkle.js is a consensus primitive whose leaf order and preimage are position-defined, '
                + 'so the copies must be edited in lockstep or commit and proof disagree');
        }
    });
});

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
 * src/merkle.js is carried byte-identically by four repos, and nothing
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
 * that drifts silently (the same reasoning as consensus-params.test.js for
 * the CONTROLLER_GUARD constants and xcall-constants-cross-repo.test.js for
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

const CARRIERS = ['xchain-indexer', 'xchain-explorer', 'xchain-sync', 'xchain-sdk'];

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('src/merkle.js is byte-identical across its four carriers', function () {

    it('this repo carries the module at all', function () {
        assert.strictEqual(fs.existsSync(path.resolve(__dirname, '..', '..', 'src', 'merkle.js')), true);
    });

    it('every carrier present on disk has the same bytes', function () {
        const root = path.resolve(__dirname, '..', '..', '..');
        const found = [];
        for (const repo of CARRIERS) {
            const p = path.join(root, repo, 'src', 'merkle.js');
            if (fs.existsSync(p)) found.push([repo, sha256File(p)]);
        }
        // Fewer than two carriers means the siblings are not checked out next to
        // this repo; the pin above still runs, so a standalone CI lane is not
        // silently toothless, it just cannot compare.
        if (found.length < 2) return this.skip();

        const [baseRepo, expected] = found[0];
        for (const [repo, digest] of found) {
            assert.strictEqual(digest, expected,
                `${repo}/src/merkle.js (${digest.slice(0, 16)}) differs from ${baseRepo}/src/merkle.js (${expected.slice(0, 16)}); `
                + 'merkle.js is a consensus primitive whose leaf order and preimage are position-defined, '
                + 'so the copies must be edited in lockstep or commit and proof disagree');
        }
    });
});

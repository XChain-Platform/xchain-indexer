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
// Decides whether each carrier path may be trusted before its bytes are hashed.
const { siblingCheckout, skipOrFail, siblingsRequired } = require('../helpers/sibling_checkout.js');

// Each carrier names its OWN src-relative path, because the feature directories are
// an xchain-indexer layout: the canonical sits under consensus/ here while the three
// vendored copies stay flat. One shared path would silently drop the canonical out of
// the comparison, leaving the three siblings agreeing with each other while the file
// this repo actually commits roots with went unchecked.
//
// The indexer's own copy is NOT listed here: resolving it as `<sibling-parent>/xchain-indexer/...`
// only works when this checkout's directory happens to be named xchain-indexer, so a lane
// worktree or a renamed clone would fail to resolve the canonical it exists to protect. It is
// pinned separately as OWN_COPY, read straight out of this checkout.
const SIBLING_CARRIERS = [
    ['xchain-explorer', 'merkle.js'],
    ['xchain-sync',     'merkle.js'],
    ['xchain-sdk',      'merkle.js'],
];

// This repo's own canonical copy, resolved from inside this checkout rather than through
// the sibling parent above, and never passed through siblingCheckout: that helper judges
// whether a SIBLING entry beside this checkout may be trusted, and the own copy is not a
// sibling, it lives inside this checkout, so that question does not apply to it.
const OWN_COPY = path.resolve(__dirname, '..', '..', 'src', 'consensus', 'merkle.js');

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
        // A carrier counts only when its checkout may be trusted. One that exists but is
        // refused (a lane symlink into a live main checkout) is kept aside with its
        // verdict, so the skip or the strict failure can name why it dropped out.
        const refused = [];
        // This repo's own copy is resolved directly from this checkout (OWN_COPY above),
        // never through the sibling loop below: it is not a sibling, so it can never be
        // refused as a lane symlink, and a missing file here fails loudly right away
        // rather than silently dropping the canonical out of found[]. This also leaves
        // the canonical-refused branch a few lines down permanently unreachable for
        // xchain-indexer specifically, since that repo no longer appears in refused[];
        // it is left in place rather than deleted, since a sibling carrier could in
        // principle still be named 'xchain-indexer' by a future SIBLING_CARRIERS entry.
        assert.ok(fs.existsSync(OWN_COPY),
            'the canonical copy did not resolve at ' + OWN_COPY + '; repoint OWN_COPY at its current path');
        found.push(['xchain-indexer/src/consensus/merkle.js', sha256File(OWN_COPY)]);
        for (const [repo, rel] of SIBLING_CARRIERS) {
            const p = path.join(root, repo, 'src', rel);
            const verdict = siblingCheckout(__dirname, p);
            if (verdict.usable) found.push([repo + '/src/' + rel, sha256File(p)]);
            else if (fs.existsSync(p)) refused.push([repo, verdict]);
        }
        // A canonical that is on disk but refused has not moved, so it takes the refusal
        // path instead of the repoint message below.
        const canonRefused = refused.find(([repo]) => repo === 'xchain-indexer');
        if (canonRefused) return skipOrFail(this, canonRefused[1], 'the merkle.js canonical pin');
        // This repo's own copy is never optional: it is the canonical the others are
        // vendored from, so a path that stopped resolving here has to fail rather than
        // leave the siblings comparing against each other.
        assert.ok(found.some(([label]) => label.startsWith('xchain-indexer/')),
            'the canonical copy did not resolve; repoint CARRIERS at its current path');
        // Under XCHAIN_REQUIRE_SIBLINGS=1 a refused carrier fails naming its reason; in soft
        // mode the usable carriers are still compared among themselves.
        if (refused.length && siblingsRequired())
            return skipOrFail(this, refused[0][1], 'the merkle.js carrier byte comparison');
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

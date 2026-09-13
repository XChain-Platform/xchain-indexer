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
 * Cross-repo VALUE-EQUALITY gate for the four XCALL/VM protocol
 * constants.
 *
 * MAX_CODE_SIZE, XCALL_MAX_GAS, XCALL_MAX_HOPS and XCALL_MIN_DEADLINE_BLOCKS
 * are enforced independently by three services: the VM (deploy size, emit-time
 * gas/hop/deadline bounds), the indexer (the consensus re-check on DEPLOY /
 * EXECUTE / XCALL) and the SDK (client-side pre-validation). Each repo carries
 * its own src/protocol/constants.js copy, and each repo's in-repo suites pin
 * that copy against ITSELF only. A one-sided bump therefore passes every CI
 * lane while splitting the fleet: the VM accepts an XCALL the indexer rejects
 * (or the reverse), which is a hashed-verdict divergence, and the SDK builds
 * actions the chain will not take.
 *
 * This is the gate that ties the copies together, mirroring the
 * cross-repo repin guard (consensus-params.test.js, the six CONTROLLER_GUARD
 * gate constants): read every sibling's constants file straight off disk and
 * assert value equality, rather than trusting three independent literal pins to
 * be edited in lockstep.
 *
 * Two layers, deliberately:
 *   1. a GOLDEN pin, which runs everywhere including a standalone checkout, so
 *      a bump in ANY single repo reddens that repo's own CI immediately; and
 *   2. the sibling reads, which prove the other copies agree.
 * Layer 1 exists because layer 2 skips when the siblings are absent. Where the
 * siblings ARE provided (bin/ci-all.sh, the monorepo drift-guard job), export
 * XCHAIN_REQUIRE_SIBLINGS=1 and a missing sibling becomes a hard failure rather
 * than a silent skip, so the gate can never pass green-by-skip.
 *
 * The canonical xchain-documentation/protocol/constants.js copy is checked too:
 * it is the published contract and no runtime code imports it, so it is the copy
 * most likely to rot.
 *
 * A real bump is a coordinated release-team event: move all three
 * src/protocol/constants.js copies, the documentation copy and the GOLDEN below
 * in one change, behind a block-height/flag-day activation if the chain is live.
 *
 * This file is kept BYTE-IDENTICAL in xchain-vm, xchain-indexer and xchain-sdk
 * (asserted below), so each repo's own CI carries the whole gate.
 ********************************************************************/

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// The gated set and its frozen values. Editing a value here without moving all
// four constants files (and the consumers that enforce them) is the exact
// mistake this guard exists to catch.
const GOLDEN = {
    MAX_CODE_SIZE:             65536,
    XCALL_MAX_GAS:             200000,
    XCALL_MAX_HOPS:            2,
    XCALL_MIN_DEADLINE_BLOCKS: 10
};
const GATED = Object.keys(GOLDEN);

// Where each participating repo files its copy of THIS guard. Listed rather
// than globbed so a repo that quietly deletes its copy reddens the others.
const GUARD_PATHS = {
    'xchain-vm':      'test/determinism/xcall-constants-cross-repo.test.js',
    'xchain-indexer': 'test/unit/xcall-constants-cross-repo.test.js',
    'xchain-sdk':     'test/unit/xcall-constants-cross-repo.test.js'
};
const REPOS = Object.keys(GUARD_PATHS);

const CONSTANTS_REL = path.join('src', 'protocol', 'constants.js');
const DOC_REL       = path.join('xchain-documentation', 'protocol', 'constants.js');

// Located by walking up to the nearest package.json rather than by a fixed
// number of '..' hops, so this file stays byte-identical across siblings that
// file their tests at different depths.
const REPO_ROOT = (function () {
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
        const up = path.dirname(dir);
        if (up === dir) throw new Error('no package.json above ' + __dirname);
        dir = up;
    }
    return dir;
})();
const SELF          = path.basename(REPO_ROOT);
const PLATFORM_ROOT = path.dirname(REPO_ROOT);

// Required-sibling policy, same convention as lint-parity.test.js: a missing
// sibling checkout skips by default (standalone clones and local dev run
// without one), and hard-fails wherever XCHAIN_REQUIRE_SIBLINGS=1 declares the
// siblings were provided on purpose.
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
function siblingOrSkip(ctx, absPath, what) {
    if (fs.existsSync(absPath)) return true;
    if (REQUIRE_SIBLINGS) {
        assert.fail('cross-repo constants gate cannot run: ' + what + ' missing at ' +
            absPath + '; XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip');
    }
    ctx.skip();
    return false;
}

// Fresh read per call: these files are plain constant tables, but a cached
// module from an earlier suite would hide an on-disk edit.
function loadConstants(absPath) {
    const resolved = require.resolve(absPath);
    delete require.cache[resolved];
    return require(resolved);
}

function sha256(absPath) {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

describe('XCALL/VM protocol constants agree across vm/indexer/sdk', function () {

    it('runs inside one of the three participating repos', function () {
        // Guards the walk-up above: if REPO_ROOT resolved somewhere unexpected
        // every sibling path below would be wrong, and the whole suite would
        // skip itself into a false green.
        assert.ok(REPOS.includes(SELF),
            'expected to run from one of ' + REPOS.join(', ') + ', resolved repo root ' + REPO_ROOT);
    });

    it('this repo pins the four constants at the frozen values', function () {
        const local = loadConstants(path.join(REPO_ROOT, CONSTANTS_REL));
        for (const name of GATED) {
            assert.strictEqual(local[name], GOLDEN[name],
                SELF + ' ' + CONSTANTS_REL + ': ' + name + ' drifted from the frozen value; a bump ' +
                'is a coordinated consensus event across vm/indexer/sdk + the documentation copy');
        }
    });

    for (const peer of REPOS) {
        it('sibling ' + peer + ' declares the same four values', function () {
            if (peer === SELF) this.skip();
            const peerRoot = path.join(PLATFORM_ROOT, peer);
            if (!siblingOrSkip(this, path.join(peerRoot, CONSTANTS_REL), peer + ' ' + CONSTANTS_REL)) return;
            const theirs = loadConstants(path.join(peerRoot, CONSTANTS_REL));
            for (const name of GATED) {
                assert.strictEqual(theirs[name], GOLDEN[name],
                    peer + ' ' + CONSTANTS_REL + ': ' + name + ' = ' + theirs[name] + ', expected ' +
                    GOLDEN[name] + '. The copies must move in lockstep or the fleet forks on the ' +
                    'first DEPLOY/EXECUTE/XCALL that lands between the two bounds');
            }
        });
    }

    it('the canonical xchain-documentation copy pins the same four values', function () {
        // Nothing at runtime requires the documentation copy, so it cannot rot
        // loudly on its own. It is the published protocol contract; hold it to
        // the same values as the code.
        const docFile = path.join(PLATFORM_ROOT, DOC_REL);
        if (!siblingOrSkip(this, docFile, DOC_REL)) return;
        const doc = loadConstants(docFile);
        for (const name of GATED) {
            assert.strictEqual(doc[name], GOLDEN[name],
                DOC_REL + ': ' + name + ' drifted from the enforced value; the published contract ' +
                'and the three enforcing copies must agree');
        }
    });

    for (const peer of REPOS) {
        it('sibling ' + peer + ' carries this guard, byte-identical', function () {
            if (peer === SELF) this.skip();
            const peerRoot = path.join(PLATFORM_ROOT, peer);
            if (!siblingOrSkip(this, peerRoot, peer + ' checkout')) return;
            const peerGuard = path.join(peerRoot, GUARD_PATHS[peer]);
            assert.ok(fs.existsSync(peerGuard),
                peer + ' is missing its copy of this gate at ' + GUARD_PATHS[peer] + '; every ' +
                'participating repo must carry it so the drift reddens whichever CI runs');
            assert.strictEqual(sha256(peerGuard), sha256(__filename),
                'GUARD DRIFT: ' + peer + '/' + GUARD_PATHS[peer] + ' differs from ' +
                SELF + '/' + GUARD_PATHS[SELF] + '; re-sync the copies so one repo cannot ' +
                'weaken the gate the others rely on');
        });
    }
});

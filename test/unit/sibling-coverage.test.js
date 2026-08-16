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

// What this suite exists to stop: a GREEN run that verified less than it looks
// like it did.
//
// Nineteen guards across test/unit and test/integration are byte-identity or
// value-parity checks against a SIBLING checkout (the consensus twins against
// xchain-sync and xchain-sdk, the vendored coins registry against xchain-hub,
// the lint and metering copies against xchain-vm, and so on). Every one of
// them resolves its sibling with existsSync and calls this.skip() when it is
// absent. That is the right behaviour for a single-repo checkout, and it is
// invisible: mocha reports a skipped test as `pending`, the suite still exits
// 0, and the push gate prints PASS. A sibling the CI venue was never told to
// ship (.ci-siblings) is therefore indistinguishable, in the output, from one
// whose guards all ran and passed.
//
// Measured 2026-08-12 against a full local checkout, a venue carrying only
// this repo's then-declared siblings ran the same counts as the full checkout:
// this repo's roster was already fully declared, which is why the yield here
// is zero rather than unmeasured.
//
// This file does not intercept those skips (that would mean rewriting every
// guard, which is the sort of churn that breaks what it means to protect). It
// answers the question their silence leaves open: WHICH siblings were
// resolvable for this run, and therefore which guard families could not have
// run. The summary prints on every run, pass or fail.
//
// XCHAIN_REQUIRE_SIBLINGS=1 turns absence into a FAILURE, matching the switch
// the individual guards already honour, so a venue that is supposed to carry
// the full checkout proves it rather than asserting it. Default (unset) stays
// permissive so a single-repo clone is green.
//
// Ported from xchain-sdk/test/unit/sibling-coverage.test.js.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_ROOT    = path.join(__dirname, '..', '..');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(REPO_ROOT, '..');
const STRICT       = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// Each entry names a sibling checkout, the env overrides the existing suites
// already read for it (first one set wins, so this resolves exactly as they do),
// a path that must exist inside it to count as a real checkout rather than an
// empty directory, and the guard family that goes quiet when it is missing.
// altEnvs name an override that points straight at the material a guard needs
// (a schema directory, say) rather than at the repo: set and present, the guard
// runs, so the sibling is not what that run is missing.
const SIBLINGS = [
    { repo: 'xchain-hub', envs: ['XCHAIN_HUB_DIR'],
      marker: path.join('src', 'coins'),
      guards: 'vendored coins-registry byte-identity, the attest-relay and snapshot-reorg activation parity, and the mirror bigint twin' },
    { repo: 'xchain-sync', envs: ['XCHAIN_SYNC_PATH'],
      marker: 'src',
      guards: 'block-hash conformance, merkle and escrow-journal twins, and rollback coverage' },
    { repo: 'xchain-documentation', envs: ['XCHAIN_DOCS_DIR'],
      marker: 'protocol',
      guards: 'action-manifest, consensus-primitive, activation-constant and XCALL constant conformance' },
    { repo: 'xchain-vm', envs: [],
      marker: 'src',
      guards: 'the lint and metering vendored copies, consensus params, and the controller integration scenarios' },
    { repo: 'xchain-sdk', envs: ['XCHAIN_SDK_PATH'],
      marker: 'src',
      guards: 'the action roundtrip golden, address-ref field conformance, and the merkle twin' },
    { repo: 'xchain-decoder', envs: [],
      marker: path.join('src', 'sql'),
      altEnvs: ['XCHAIN_DECODER_SQL_PATH'],
      guards: 'the decoder schema the integration scenarios build their fixtures from' },
    { repo: 'xchain-explorer', envs: [],
      marker: 'src',
      guards: 'the merkle twin, the state-checkpoint fence parity, and the explorer launcher' },
];

function resolve(entry) {
    for (const key of entry.envs) {
        if (process.env[key]) return { dir: process.env[key], via: key };
    }
    return { dir: path.join(SIBLING_ROOT, entry.repo), via: 'sibling root' };
}

// Present means "a real checkout", not merely "a directory exists": an empty
// placeholder would resolve and then every guard inside it would still skip,
// which is the exact silence this file exists to break.
function inspect(entry) {
    const { dir, via } = resolve(entry);
    let present = fs.existsSync(dir) && fs.existsSync(path.join(dir, entry.marker));
    let source  = via;
    if (!present) {
        for (const key of entry.altEnvs || []) {
            if (process.env[key] && fs.existsSync(process.env[key])) {
                present = true;
                source  = key;
                break;
            }
        }
    }
    return Object.assign({}, entry, { dir, via: source, present });
}

describe('cross-repo sibling coverage (what this run could NOT verify)', function () {

    const results = SIBLINGS.map(inspect);
    const absent  = results.filter(r => !r.present);

    // Prints on every run. A reader of CI output should never have to diff two
    // pending counts to discover that a vendored-copy guard did not run.
    before(function () {
        const mode = STRICT ? 'STRICT (absence fails)' : 'permissive (absence skips)';
        console.log(`      sibling coverage: ${results.length - absent.length}/${results.length} resolvable, ${mode}`);
        for (const r of absent) {
            console.log(`      NOT VERIFIED: ${r.repo} absent at ${r.dir} (${r.via}) -> ${r.guards}`);
        }
    });

    it('reports every sibling it looked for, so the list itself cannot rot silently', function () {
        // A guard that checks nothing is the failure mode being prevented, so the
        // roster must be non-empty and every entry must be answerable.
        assert.ok(results.length > 0, 'the sibling roster is empty');
        for (const r of results) {
            assert.ok(typeof r.dir === 'string' && r.dir !== '', r.repo + ' resolved to nothing');
            assert.strictEqual(typeof r.present, 'boolean', r.repo + ' presence must be a decided boolean');
        }
    });

    // The roster is only as good as its agreement with .ci-siblings: a sibling
    // listed here but never declared is exactly the gap this file was written for,
    // and it would otherwise reappear the moment someone adds a guard.
    it('declares every sibling it lists in .ci-siblings, so the venue ships them', function () {
        const declFile = path.join(REPO_ROOT, '.ci-siblings');
        assert.ok(fs.existsSync(declFile), '.ci-siblings is missing from ' + REPO_ROOT);
        // A declaration may carry modifiers: `name@branch` pins the branch the
        // harness ships, `name+scripts` gives a sibling a scripts-running
        // install (xchain-vm, whose isolated-vm binding this suite executes).
        // The NAME is the declaration, so read past both. Matching the whole
        // line read a modified entry as undeclared, which fails the run for the
        // one thing that was not wrong with it.
        const declared = fs.readFileSync(declFile, 'utf8').split('\n')
            .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
            .map(l => l.split('+')[0].split('@')[0]);
        const undeclared = results.map(r => r.repo).filter(r => !declared.includes(r));
        assert.deepStrictEqual(undeclared, [],
            'these siblings carry cross-repo guards but are not declared in .ci-siblings, so the '
            + 'venue never checks them out and every guard against them skips while the gate prints '
            + 'PASS: ' + undeclared.join(', '));
    });

    it('resolves every sibling checkout the cross-repo guards depend on', function () {
        if (!absent.length) return;
        const detail = absent.map(r => `${r.repo} (expected ${r.dir}, via ${r.via}; silences ${r.guards})`).join('; ');
        if (STRICT) {
            throw new Error(
                `XCHAIN_REQUIRE_SIBLINGS=1 but ${absent.length} sibling checkout(s) are missing: ${detail}. `
                + 'Every cross-repo parity guard against them skipped, so this run proves less than a green '
                + 'result suggests. Check the siblings out, or unset XCHAIN_REQUIRE_SIBLINGS to accept the gap.');
        }
        // Permissive mode: recorded above and in the pending list, never a failure,
        // so a single-repo clone stays green.
        this.skip();
    });
});

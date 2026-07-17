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
 * test/unit/flagdayPlaceholderGuard.test.js
 *
 *  flag-day placeholder regression gate.
 *
 * On 2026-07-16 the operator ratified 2026-10-01 00:00 UTC (unix 1790812800)
 * as the coordinated activation anchor, and  derived every remaining
 * placeholder from it:
 *   - the four 2026-07-15 hardening gates in protocol_changes.js moved from
 *     the 1798761600 (2027-01-01) placeholder onto the ratified anchor,
 *     joining the confirmed 2.0.0 contract-era cohort;
 *   - ARCHIVE_REWARD_ACTIVATION and RETRACTION_SIGNING_ACTIVATION moved from
 *     the 983000 (~2027-01-01) BTC placeholder to 969500, the BTC
 *     snapshot_block landing ~2026-10-01 (tip 957062 on 07-07 + ~144/day).
 *
 * This suite is the gate the runbook's "grep for placeholder regressions"
 * verify step automates: a re-introduced placeholder (or a gate silently
 * drifting off the ratified values) fails CI instead of silently leaving a
 * consensus protection dark on mainnet until 2027. The ONLY line permitted
 * to carry 1798761600 is the CROSS_CHAIN_ROYALTY create-side entry, whose
 * one-quarter-after-CONTROLLER_GUARD deny window is CONFIRMED by design
 * (flag-day inventory, Decision 5).
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');

const RATIFIED_ANCHOR_TS  = 1790812800;   // 2026-10-01 00:00:00 UTC
const RATIFIED_BTC_HEIGHT = 969500;       // BTC snapshot_block ~2026-10-01
const ROYALTY_CREATE_SIDE = 1798761600;   // 2027-01-01, CONFIRMED (deny window)

const XC104_TS_GATES = [
    'MINT_SELF_MINTED_ONLY',
    'VOTE_BINDING_MINIMUMS',
    'VOTE_CALLBACK_TIMELOCK',
    'ATTEST_CANONICAL_LOWERCASE_ID',
];

describe(' flag-day placeholder guard @regression @tier1', function () {

    const pcSource = fs.readFileSync(path.join(SRC, 'protocol_changes.js'), 'utf8');

    it('the four hardening gates are armed on the ratified 2026-10-01 anchor', function () {
        for (const gate of XC104_TS_GATES) {
            const m = pcSource.match(new RegExp(
                "this\\.addChange\\('" + gate + "', '2\\.0\\.0',(\\d+)"));
            assert.ok(m, gate + ' must be registered as a 2.0.0 time-gated change');
            assert.strictEqual(parseInt(m[1]), RATIFIED_ANCHOR_TS,
                gate + ' mainnet timestamp must be the ratified anchor; a divergent value is a fork');
        }
    });

    it('no timestamp gate besides the CONFIRMED royalty create-side carries 1798761600', function () {
        const lines = pcSource.split('\n')
            .filter(l => l.includes(String(ROYALTY_CREATE_SIDE)))
            .filter(l => /this\.addChange\(/.test(l));
        assert.strictEqual(lines.length, 1,
            'exactly one addChange may sit at 1798761600 (the royalty create-side deny window); got: ' + lines.join(' | '));
        assert.ok(lines[0].includes('CROSS_CHAIN_ROYALTY'),
            'the surviving 1798761600 entry must be CROSS_CHAIN_ROYALTY');
    });

    it('ARCHIVE_REWARD_ACTIVATION is armed at the derived BTC height (983000 placeholder gone)', function () {
        const mod = require(path.join(SRC, 'anchor_reward_activation.js'));
        assert.strictEqual(mod.ARCHIVE_REWARD_ACTIVATION.mainnet, RATIFIED_BTC_HEIGHT);
        assert.strictEqual(mod.isArchiveRewardActive(RATIFIED_BTC_HEIGHT - 1, 'mainnet'), false);
        assert.strictEqual(mod.isArchiveRewardActive(RATIFIED_BTC_HEIGHT, 'mainnet'), true);
    });

    it('RETRACTION_SIGNING_ACTIVATION is armed at the derived BTC height (983000 placeholder gone)', function () {
        const mod = require(path.join(SRC, 'retraction_signing_activation.js'));
        assert.strictEqual(mod.RETRACTION_SIGNING_ACTIVATION.mainnet, RATIFIED_BTC_HEIGHT);
        assert.strictEqual(mod.isRetractionSigningActive(RATIFIED_BTC_HEIGHT - 1, 'mainnet'), false);
        assert.strictEqual(mod.isRetractionSigningActive(RATIFIED_BTC_HEIGHT, 'mainnet'), true);
    });

    // Cross-service sweep: resolved by monorepo-relative path, so this only runs in the
    // monorepo/aggregator checkout; standalone single-repo CI skips (unless a required-
    // sibling job sets XCHAIN_REQUIRE_SIBLINGS=1, where a missing sibling hard-fails).
    describe('sibling copies carry no placeholder regression', function () {
        const SIBLING_FILES = [
            '../../../xchain-hub/src/anchor_reward_activation.js',
            '../../../xchain-hub/src/retraction_signing_activation.js',
            '../../../xchain-explorer/src/retraction_signing_activation.js',
            '../../../xchain-documentation/protocol/constants.js',
        ];

        for (const rel of SIBLING_FILES) {
            it(rel.replace(/^(\.\.\/)+/, '') + ' has no 983000 placeholder and pins the derived height', function () {
                const p = path.resolve(__dirname, rel);
                if (!fs.existsSync(p)) {
                    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                        assert.fail('required sibling missing: ' + p);
                    return this.skip();
                }
                const s = fs.readFileSync(p, 'utf8');
                assert.ok(!s.includes('983000'),
                    p + ' still carries the retired 983000 placeholder');
                assert.ok(s.includes('mainnet: ' + RATIFIED_BTC_HEIGHT),
                    p + ' must pin the derived mainnet height ' + RATIFIED_BTC_HEIGHT);
            });
        }
    });
});

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
 * On 2026-07-16 the operator ratified a coordinated activation anchor and
 *  derived every remaining placeholder from it. The set has TWO halves,
 * because the gates it covers are not all keyed on the same thing:
 *   - a TIME half. The 2026-07-15 hardening gates in protocol_changes.js moved
 *     off the 1798761600 (2027-01-01) placeholder onto the ratified timestamp,
 *     joining the confirmed 2.0.0 contract-era cohort. That timestamp has since
 *     been repinned twice (, then) and now reads 1786060800
 *     (2026-08-07);
 *   - a BTC-HEIGHT half, for the gates keyed on a snapshot_block rather than a
 *     block time. It moved off the 983000 (~2027-01-01) placeholder onto 969500.
 *
 *, 2026-08-12: the two halves had drifted eight weeks apart, because
 * both TIME repins moved only the timestamp and left 969500 (~2026-10-01)
 * standing. A fleet in that window runs hubs whose reward, retraction, relay and
 * governance-snapshot rules are still pre-flag-day while their indexers are past
 * theirs, which is the boundary-skew shape that halts a follower. The height
 * half is therefore re-derived onto 963000, the  pre-freeze train boundary
 * (tip 959,853 on 2026-07-27 + 21d at ~144/day) already armed for BTC:mainnet in
 * stateHash.js, caret_ref_strict_activation.js and list_edit_resolution_
 * activation.js. It is NOT re-derived onto the timestamp's own calendar date:
 * 2026-08-07 is in the past, and a height in the past is not a flag day at all
 * (a node replaying from genesis applies the rule from it while a long-running
 * node never did, and the two diverge at the first hash comparison).
 *
 * This suite is the gate the runbook's "grep for placeholder regressions"
 * verify step automates: a re-introduced placeholder (or a gate silently
 * drifting off the ratified values) fails CI instead of silently leaving a
 * consensus protection dark on mainnet until 2027. The ONLY line permitted
 * to carry 1798761600 is the CROSS_CHAIN_ROYALTY create-side entry, whose
 * one-quarter-after-CONTROLLER_GUARD deny window is CONFIRMED by design
 * (flag-day inventory, Decision 5). Since  it also asserts the height
 * half is ONE value across every member: the defect that item recorded was not
 * a wrong number, it was a repin that moved some members and not others.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');

const RATIFIED_ANCHOR_TS  = 1786060800;   // 2026-08-07 00:00:00 UTC
const RATIFIED_BTC_HEIGHT = 963000;       //  re-pin: the  pre-freeze train boundary
const ROYALTY_CREATE_SIDE = 1798761600;   // 2027-01-01, CONFIRMED (deny window)

const XC104_TS_GATES = [
    'MINT_SELF_MINTED_ONLY',
    'VOTE_BINDING_MINIMUMS',
    'VOTE_CALLBACK_TIMELOCK',
    'ATTEST_CANONICAL_LOWERCASE_ID',
    'DISPENSER_CLOSE_PER_UNIT',
    //  (flag-day Pkg 4): VM deploy-linter hardening arms at the SAME
    // ratified anchor as VM_BANNED_ASYNC (zero partially-hardened window).
    'VM_LINT_HARDENING',
];

describe(' flag-day placeholder guard @regression @tier1', function () {

    const pcSource = fs.readFileSync(path.join(SRC, 'protocol_changes.js'), 'utf8');

    it('the  timestamp gates are armed on the ratified 2026-08-07 anchor', function () {
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

    //: the whole BTC-height half moves together or not at all.
    //
    // The two named tests above pin ARCHIVE_REWARD and RETRACTION_SIGNING because
    // those were the two members  derived. PRICE_SIG_TALLY  and
    // ATTEST_RELAY  were armed onto the same anchor later and were pinned
    // nowhere in this file, which is exactly how  happened: the  and
    //  repins moved the TIME half and nothing failed when the HEIGHT half
    // stayed behind. Enumerating the cohort by name here makes a partial re-pin a
    // CI failure rather than an eight-week boundary skew nobody notices.
    const XC104_HEIGHT_COHORT = [
        ['anchor_reward_activation.js',        'ARCHIVE_REWARD_ACTIVATION',    'isArchiveRewardActive'],
        ['retraction_signing_activation.js',   'RETRACTION_SIGNING_ACTIVATION', 'isRetractionSigningActive'],
        ['price_sig_tally_activation.js',      'PRICE_SIG_TALLY_ACTIVATION',   'isPriceSigTallyVerifyFirstActive'],
        ['attest_relay_activation.js',         'ATTEST_RELAY_ACTIVATION',      'isAttestRelayActive'],
    ];

    it('every member of the  BTC-height cohort carries the SAME mainnet height', function () {
        for (const [file, mapName] of XC104_HEIGHT_COHORT) {
            const map = require(path.join(SRC, file))[mapName];
            assert.ok(map && typeof map === 'object', file + ' must export ' + mapName);
            assert.strictEqual(map.mainnet, RATIFIED_BTC_HEIGHT,
                mapName + ' is at ' + map.mainnet + ', not the cohort height ' + RATIFIED_BTC_HEIGHT +
                '. A re-pin that moves some members and not others leaves the fleet running one ' +
                'rule set on its hubs and another on its indexers between the two boundaries.');
            // testnet/regtest are genesis-active for the whole cohort; a member that
            // quietly arms a venue height is a different gate wearing the cohort's name.
            assert.strictEqual(map.testnet, 0, mapName + '.testnet must be genesis-active');
            assert.strictEqual(map.regtest, 0, mapName + '.regtest must be genesis-active');
        }
    });

    it('every cohort member flips exactly at the shared height, not one block either side', function () {
        for (const [file, , fnName] of XC104_HEIGHT_COHORT) {
            const fn = require(path.join(SRC, file))[fnName];
            assert.strictEqual(fn(RATIFIED_BTC_HEIGHT - 1, 'mainnet'), false, fnName + ' fired below the cohort height');
            assert.strictEqual(fn(RATIFIED_BTC_HEIGHT, 'mainnet'), true, fnName + ' did not fire at the cohort height');
            assert.strictEqual(fn(RATIFIED_BTC_HEIGHT + 1, 'mainnet'), true, fnName + ' did not stay on above the cohort height');
        }
    });

    it('the cohort height is still in the FUTURE relative to the ratified TIME anchor era', function () {
        // The failure this guards is the one the  re-pin had to avoid: pinning
        // the height half onto the calendar date of the TIME half. That date is past,
        // and a height in the past is not a flag day (a genesis replay applies the rule
        // from it, a long-running node never did, and they diverge at the first hash).
        // 961000 is the last boundary the chain has already crossed, so anything at or
        // below it is by definition retroactive.
        const CROSSED = require(path.join(SRC, 'anchor_reward_activation.js')).ANCHOR_REWARD_ACTIVATION.mainnet;
        assert.ok(RATIFIED_BTC_HEIGHT > CROSSED,
            'the  height cohort (' + RATIFIED_BTC_HEIGHT + ') is at or below the already-crossed ' +
            CROSSED + ' boundary, which arms it retroactively');
    });

    it('SLASH_BURNS_PENDING_STAKE mainnet_block equals EQUIV_HEADER_ACTIVATION.mainnet (no duplicated-constant drift, #3134)', function () {
        // The gate is deliberately anchored to the EQUIV flag-day HEIGHT, but the literal
        // 961000 is duplicated in protocol_changes.js rather than derived from the shared map.
        // Bind the two so a re-arm of the EQUIV anchor cannot silently leave this gate behind.
        const equivMainnet = require(path.join(SRC, 'equivocation_header.js')).EQUIV_HEADER_ACTIVATION.mainnet;
        const m = pcSource.match(new RegExp(
            "this\\.addChange\\('SLASH_BURNS_PENDING_STAKE', '2\\.0\\.0',\\d+,\\d+,\\d+,(\\d+)"));
        assert.ok(m, 'SLASH_BURNS_PENDING_STAKE must be registered with a mainnet_block gate');
        assert.strictEqual(parseInt(m[1]), equivMainnet,
            'SLASH_BURNS_PENDING_STAKE mainnet_block must equal EQUIV_HEADER_ACTIVATION.mainnet; divergence reopens the burn-pending window the gate exists to close');
    });

    it('SLASH_ORACLE_ROUND_DISCRIMINATED mainnet_block equals EQUIV_HEADER_ACTIVATION.mainnet ()', function () {
        // Same duplicated-literal hazard as SLASH-1 above: the XORACLE round-discrimination
        // gate is anchored to the EQUIV flag-day HEIGHT, so a re-arm of that anchor must not
        // leave this gate behind on the old height, which would reopen the window where an
        // honest price validator's two distinct rounds at one BTC tip burn its whole bond.
        const equivMainnet = require(path.join(SRC, 'equivocation_header.js')).EQUIV_HEADER_ACTIVATION.mainnet;
        const m = pcSource.match(new RegExp(
            "this\\.addChange\\('SLASH_ORACLE_ROUND_DISCRIMINATED', '2\\.0\\.0',\\d+,\\d+,\\d+,(\\d+)"));
        assert.ok(m, 'SLASH_ORACLE_ROUND_DISCRIMINATED must be registered with a mainnet_block gate');
        assert.strictEqual(parseInt(m[1]), equivMainnet,
            'SLASH_ORACLE_ROUND_DISCRIMINATED mainnet_block must equal EQUIV_HEADER_ACTIVATION.mainnet');
    });

    // Cross-service sweep: resolved by monorepo-relative path, so this only runs in the
    // monorepo/aggregator checkout; standalone single-repo CI skips (unless a required-
    // sibling job sets XCHAIN_REQUIRE_SIBLINGS=1, where a missing sibling hard-fails).
    describe('sibling copies carry no placeholder regression', function () {
        // NOTE (#2759): xchain-documentation/protocol/constants.js is deliberately NOT in
        // this substring loop. Its `mainnet: 963000` substring is vacuously satisfied by
        // ARCHIVE_REWARD_ACTIVATION, so a substring check on the docs file could never fail
        // for the retraction gate. The docs arm is asserted by named export below instead.
        const SIBLING_FILES = [
            '../../../xchain-hub/src/anchor_reward_activation.js',
            '../../../xchain-hub/src/retraction_signing_activation.js',
            '../../../xchain-explorer/src/retraction_signing_activation.js',
            // : the PRICE v0 signature-tally gate rides the SAME ratified 963000
            // anchor, so a future re-anchor has to move it along with the pair above.
            '../../../xchain-hub/src/price_sig_tally_activation.js',
            //  /: the ATTEST relay gate rides it too and was listed
            // nowhere here, so the  and  repins could not have failed on it.
            '../../../xchain-hub/src/attest_relay_activation.js',
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

        // #2759: assert the retraction gate against the canonical inventory by NAMED
        // EXPORT, not by substring. The vendored copies claim to be byte-equal to the
        // RETRACTION_SIGNING_ACTIVATION map in xchain-documentation/protocol/constants.js;
        // this makes that claim capable of failing (a re-anchor that moves the copies while
        // the docs stay silent now trips CI).
        it('xchain-documentation/protocol/constants.js pins RETRACTION_SIGNING_ACTIVATION by named export, value-equal to the vendored copy', function () {
            const p = path.resolve(__dirname, '../../../xchain-documentation/protocol/constants.js');
            if (!fs.existsSync(p)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    assert.fail('required sibling missing: ' + p);
                return this.skip();
            }
            const canon = require(p);
            assert.ok(canon.RETRACTION_SIGNING_ACTIVATION && typeof canon.RETRACTION_SIGNING_ACTIVATION === 'object',
                'constants.js must export a RETRACTION_SIGNING_ACTIVATION map (the canonical authority for the three vendored copies)');
            assert.strictEqual(canon.RETRACTION_SIGNING_ACTIVATION.mainnet, RATIFIED_BTC_HEIGHT,
                'canonical retraction mainnet height must be the ratified ' + RATIFIED_BTC_HEIGHT);
            const local = require(path.join(SRC, 'retraction_signing_activation.js')).RETRACTION_SIGNING_ACTIVATION;
            assert.deepStrictEqual(local, canon.RETRACTION_SIGNING_ACTIVATION,
                'the vendored retraction_signing_activation.js map drifted from the canonical constants.js map');
        });

        // , same reasoning: the PRICE v0 signature-tally gate is armed to the
        // ratified 963000 anchor, so it belongs to the height cohort this file guards.
        // A substring check on the docs file is vacuous here (several maps carry that
        // literal), so bind it by NAMED EXPORT to both the ratified height and the local
        // copy: a re-anchor that moves one side and not the other now trips CI.
        it('xchain-documentation/protocol/constants.js pins PRICE_SIG_TALLY_ACTIVATION by named export, value-equal to the local copy', function () {
            const p = path.resolve(__dirname, '../../../xchain-documentation/protocol/constants.js');
            if (!fs.existsSync(p)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    assert.fail('required sibling missing: ' + p);
                return this.skip();
            }
            const canon = require(p);
            assert.ok(canon.PRICE_SIG_TALLY_ACTIVATION && typeof canon.PRICE_SIG_TALLY_ACTIVATION === 'object',
                'constants.js must export a PRICE_SIG_TALLY_ACTIVATION map (the canonical authority for the indexer + hub copies)');
            assert.strictEqual(canon.PRICE_SIG_TALLY_ACTIVATION.mainnet, RATIFIED_BTC_HEIGHT,
                'canonical PRICE signature-tally mainnet height must be the ratified ' + RATIFIED_BTC_HEIGHT);
            const local = require(path.join(SRC, 'price_sig_tally_activation.js')).PRICE_SIG_TALLY_ACTIVATION;
            assert.deepStrictEqual(local, canon.PRICE_SIG_TALLY_ACTIVATION,
                'the local price_sig_tally_activation.js map drifted from the canonical constants.js map');
        });

        //, same reasoning again for the remaining two cohort members.
        it('xchain-documentation/protocol/constants.js pins ATTEST_RELAY_ACTIVATION and ARCHIVE_REWARD_ACTIVATION by named export', function () {
            const p = path.resolve(__dirname, '../../../xchain-documentation/protocol/constants.js');
            if (!fs.existsSync(p)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    assert.fail('required sibling missing: ' + p);
                return this.skip();
            }
            const canon = require(p);
            for (const [mapName, file] of [
                ['ATTEST_RELAY_ACTIVATION',   'attest_relay_activation.js'],
                ['ARCHIVE_REWARD_ACTIVATION', 'anchor_reward_activation.js'],
            ]) {
                assert.ok(canon[mapName] && typeof canon[mapName] === 'object',
                    'constants.js must export a ' + mapName + ' map');
                assert.strictEqual(canon[mapName].mainnet, RATIFIED_BTC_HEIGHT,
                    'canonical ' + mapName + ' mainnet height must be the cohort height ' + RATIFIED_BTC_HEIGHT);
                assert.deepStrictEqual(require(path.join(SRC, file))[mapName], canon[mapName],
                    'the local ' + file + ' ' + mapName + ' map drifted from the canonical constants.js map');
            }
        });

        // GOV_SNAPSHOT_ACTIVATION  is the fifth cohort member and the only one
        // that is hub-only and NOT exported: it is a file-local const inside
        // Governance.js. Requiring that module from here would drag in the whole hub
        // engine, so read the declaration out of the source instead. It still has to be
        // asserted somewhere, because it was the third file  named and nothing in
        // this tree could previously fail when a re-pin passed it by.
        it('xchain-hub/src/Governance.js declares GOV_SNAPSHOT_ACTIVATION at the cohort height', function () {
            const p = path.resolve(__dirname, '../../../xchain-hub/src/Governance.js');
            if (!fs.existsSync(p)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    assert.fail('required sibling missing: ' + p);
                return this.skip();
            }
            const m = fs.readFileSync(p, 'utf8')
                .match(/const\s+GOV_SNAPSHOT_ACTIVATION\s*=\s*\{\s*mainnet:\s*(\d+)\s*,\s*testnet:\s*(\d+)\s*,\s*regtest:\s*(\d+)\s*\}/);
            assert.ok(m, 'GOV_SNAPSHOT_ACTIVATION declaration not found in Governance.js (renamed or reshaped?)');
            assert.strictEqual(parseInt(m[1]), RATIFIED_BTC_HEIGHT,
                'GOV_SNAPSHOT_ACTIVATION.mainnet is ' + m[1] + ', not the cohort height ' + RATIFIED_BTC_HEIGHT);
            assert.strictEqual(parseInt(m[2]), 0, 'GOV_SNAPSHOT_ACTIVATION.testnet must be genesis-active');
            assert.strictEqual(parseInt(m[3]), 0, 'GOV_SNAPSHOT_ACTIVATION.regtest must be genesis-active');
        });
    });

    // #2734: retraction_signing_activation.js is a fork-relevant flag-day twin that
    // exists in three byte-identical copies (hub, indexer, explorer). It decides
    // whether a mirror REFUSES an unsigned quorum-class retraction, so a one-sided edit
    // (a comparator flip >= -> >, a testnet/regtest value change, an added second map,
    // or any body rewrite) would let the hub sign under one era rule while a mirror
    // enforces another - with no CI signal. The substring checks above only prove the
    // literal `mainnet: 963000` appears SOMEWHERE in each copy; they pass through all of
    // those drifts. Assert full-file byte-identity of the hub and explorer copies against
    // the local indexer copy (all three are byte-identical today, headers included, so a
    // plain string compare is correct). Same skip machinery as the sibling sweep above.
    describe('retraction_signing_activation.js is byte-identical across hub/indexer/explorer', function () {
        const LOCAL = path.join(SRC, 'retraction_signing_activation.js');
        const SIBLING_TWINS = [
            '../../../xchain-hub/src/retraction_signing_activation.js',
            '../../../xchain-explorer/src/retraction_signing_activation.js',
        ];
        for (const rel of SIBLING_TWINS) {
            it(rel.replace(/^(\.\.\/)+/, '') + ' is byte-identical to the indexer copy', function () {
                const p = path.resolve(__dirname, rel);
                if (!fs.existsSync(p)) {
                    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                        assert.fail('required sibling missing: ' + p);
                    return this.skip();
                }
                const local   = fs.readFileSync(LOCAL, 'utf8');
                const sibling = fs.readFileSync(p, 'utf8');
                assert.strictEqual(sibling, local,
                    p + ' has diverged from the indexer copy of retraction_signing_activation.js. ' +
                    'All three copies (hub, indexer, explorer) must stay byte-identical; a one-sided ' +
                    'edit to this flag-day twin forks retraction acceptance between the hub and its ' +
                    'mirrors. Reconcile the three copies.');
            });
        }
    });
});

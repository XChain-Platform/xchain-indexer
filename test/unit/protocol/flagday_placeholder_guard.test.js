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
 * test/unit/protocol/flagday_placeholder_guard.test.js
 *
 * flag-day placeholder regression gate.
 *
 * On 2026-07-16 the operator ratified a coordinated activation anchor and
 * derived every remaining placeholder from it. The set has TWO halves,
 * because the gates it covers are not all keyed on the same thing:
 *   - a TIME half. The 2026-07-15 hardening gates in protocol_changes.js moved
 *     off the 1798761600 (2027-01-01) placeholder onto the ratified timestamp,
 *     joining the confirmed 0.2.0 contract-era cohort. That timestamp has since
 *     been repinned twice and now reads 1786060800
 *     (2026-08-07);
 *   - a BTC-HEIGHT half, for the gates keyed on a snapshot_block rather than a
 *     block time. It moved off the 983000 (~2027-01-01) placeholder onto 969500.
 *
 * 2026-08-12: the two halves had drifted eight weeks apart, because
 * both TIME repins moved only the timestamp and left 969500 (~2026-10-01)
 * standing. A fleet in that window runs hubs whose reward, retraction, relay and
 * governance-snapshot rules are still pre-flag-day while their indexers are past
 * theirs, which is the boundary-skew shape that halts a follower. The height
 * half is therefore re-derived onto 963000, the pre-freeze train boundary
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
 * consensus protection dark on mainnet until 2027. TWO lines are permitted
 * to carry 1798761600: the CROSS_CHAIN_ROYALTY create-side entry, whose
 * one-quarter-after-CONTROLLER_GUARD deny window is CONFIRMED by design
 * (flag-day inventory, Decision 5), and REST_PATTERN_METER, admitted by
 * ruling 2026-09-09 as a deliberate second occupant of that same confirmed
 * instant so the fleet gets one coordination event rather than two. The
 * allow-list is by NAME with an exact count, so a THIRD entry still reddens.
 * Since it also asserts the height
 * half is ONE value across every member: the defect that item recorded was not
 * a wrong number, it was a repin that moved some members and not others.
 *
 * The named-export pins of the remaining cohort members and the hub-only
 * GOV_SNAPSHOT_ACTIVATION declaration live beside this file in
 * flagday_placeholder_guard.test/, opening the same describe so every full
 * test title is unchanged. The retraction twin byte identity went with the
 * shim in W5: the row is a registry row, twinned by the registry parts.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');


const SRC = path.join(__dirname, '..', '..', '..', 'src');
// The cohort rows are registry rows (W5 retired their predicate-only shims).
const registry = require(path.join(SRC, 'consensus', 'gate_registry'));

const RATIFIED_ANCHOR_TS  = 1786060800;   // 2026-08-07 00:00:00 UTC
const RATIFIED_BTC_HEIGHT = 963000;       // re-pin: the pre-freeze train boundary
const ROYALTY_CREATE_SIDE = 1798761600;   // 2027-01-01, CONFIRMED (deny window)

const XC104_TS_GATES = [
    'MINT_SELF_MINTED_ONLY',
    'VOTE_BINDING_MINIMUMS',
    'VOTE_CALLBACK_TIMELOCK',
    'ATTEST_CANONICAL_LOWERCASE_ID',
    'DISPENSER_CLOSE_PER_UNIT',
    // (flag-day Pkg 4): VM deploy-linter hardening arms at the SAME
    // ratified anchor as VM_BANNED_ASYNC (zero partially-hardened window).
    'VM_LINT_HARDENING',
];

// The time table as the class builds it under the manifest stub: the rows live in
// src/protocol_changes/changes_*.js now, so the guard reads values, not source text.
const pcTable = new (require(path.join(SRC, 'protocol_changes.js')))({ config: {}, util: {} }).changes;
const is020 = (row) => row && row.version_major === 0 && row.version_minor === 2 && row.version_revision === 0;

describe('flag-day placeholder guard @regression @tier1', function () {
    it('the timestamp gates are armed on the ratified 2026-08-07 anchor', function () {
        for (const gate of XC104_TS_GATES) {
            const row = pcTable[gate];
            assert.ok(is020(row), gate + ' must be registered as a 0.2.0 time-gated change');
            assert.strictEqual(row.mainnet_time, RATIFIED_ANCHOR_TS,
                gate + ' mainnet timestamp must be the ratified anchor; a divergent value is a fork');
        }
    });

    it('only the two RATIFIED occupants of 1798761600 sit there, and nothing drifts back', function () {
        // 1798761600 has two lives in this tree and the difference is the whole point of
        // this guard. It was the PLACEHOLDER the 2026-07-15 hardening gates were evacuated
        // from (see the file header), and it is ALSO a real scheduled instant: the
        // CROSS_CHAIN_ROYALTY create-side deny window.
        //
        // REST_PATTERN_METER is admitted here by ruling 2026-09-09, as a deliberate second
        // occupant rather than a drift-back. Its VM twin
        // (xchain-vm REST_PATTERN_METER_GATE_BLOCK_TIME) documents the reason: the
        // contract-era instant is in the PAST, so reusing it would retroactively re-price
        // every rest destructure already executed, and it shares the royalty instant so the
        // fleet gets ONE coordination event instead of two.
        //
        // The allow-list is by NAME and the count is exact, so a THIRD entry, or either of
        // these two silently becoming something else, still reddens exactly as before. Do
        // not widen this to a bare count.
        const RATIFIED_OCCUPANTS = ['CROSS_CHAIN_ROYALTY', 'REST_PATTERN_METER'];
        const lines = Object.entries(pcTable)
            .filter(([, row]) => Object.values(row).includes(ROYALTY_CREATE_SIDE))
            .map(([name]) => "'" + name + "'");
        assert.strictEqual(lines.length, RATIFIED_OCCUPANTS.length,
            'exactly ' + RATIFIED_OCCUPANTS.length + ' addChange entries may sit at 1798761600 (' +
            RATIFIED_OCCUPANTS.join(' + ') + '); got: ' + lines.join(' | '));
        for (const name of RATIFIED_OCCUPANTS) {
            assert.ok(lines.some(l => l.includes("'" + name + "'")),
                name + ' must be one of the 1798761600 entries; a rename or a repin must move it deliberately');
        }
    });

    it('ARCHIVE_REWARD_ACTIVATION is armed at the derived BTC height (983000 placeholder gone)', function () {
        const mod = require(path.join(SRC, 'consensus', 'gates', 'anchor_reward_gate.js'));
        assert.strictEqual(mod.ARCHIVE_REWARD_ACTIVATION.mainnet, RATIFIED_BTC_HEIGHT);
        assert.strictEqual(mod.isArchiveRewardActive(RATIFIED_BTC_HEIGHT - 1, 'mainnet'), false);
        assert.strictEqual(mod.isArchiveRewardActive(RATIFIED_BTC_HEIGHT, 'mainnet'), true);
    });

    it('RETRACTION_SIGNING_ACTIVATION is armed at the derived BTC height (983000 placeholder gone)', function () {
        // A registry row since W5 (its predicate-only shim is gone): the callers read it
        // through activeAt() by this key, so the guard reads it the same way.
        const key = 'retraction_signing_activation.RETRACTION_SIGNING_ACTIVATION';
        assert.strictEqual(registry.get(key).mainnet, RATIFIED_BTC_HEIGHT);
        assert.strictEqual(registry.activeAt(key, 'mainnet', null, RATIFIED_BTC_HEIGHT - 1, null), false);
        assert.strictEqual(registry.activeAt(key, 'mainnet', null, RATIFIED_BTC_HEIGHT, null), true);
    });
});

describe('flag-day placeholder guard @regression @tier1', function () {
    // the whole BTC-height half moves together or not at all.
    //
    // The two named tests above pin ARCHIVE_REWARD and RETRACTION_SIGNING because
    // those were the two members derived. PRICE_SIG_TALLY and
    // ATTEST_RELAY were armed onto the same anchor later and were pinned
    // nowhere in this file, which is exactly how happened: the and
    // repins moved the TIME half and nothing failed when the HEIGHT half
    // stayed behind. Enumerating the cohort by name here makes a partial re-pin a
    // CI failure rather than an eight-week boundary skew nobody notices.
    // Registry keys since W3: the four rows the cohort is made of. Three of the
    // four shims went with W5 and their callers read the row by key, so the guard
    // reads every member through the registry (get for the map, activeAt for the
    // flip) rather than through a module that may or may not still exist.
    const XC104_HEIGHT_COHORT = [
        'anchor_reward_activation.ARCHIVE_REWARD_ACTIVATION',
        'retraction_signing_activation.RETRACTION_SIGNING_ACTIVATION',
        'price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION',
        'attest_relay_activation.ATTEST_RELAY_ACTIVATION',
    ];

    it('every member of the BTC-height cohort carries the SAME mainnet height', function () {
        for (const key of XC104_HEIGHT_COHORT) {
            const mapName = key.slice(key.indexOf('.') + 1);
            const map = registry.get(key);
            assert.ok(map && typeof map === 'object', key + ' must be a registry row');
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
        for (const key of XC104_HEIGHT_COHORT) {
            const fn = (height, network) => registry.activeAt(key, network, null, height, null);
            assert.strictEqual(fn(RATIFIED_BTC_HEIGHT - 1, 'mainnet'), false, key + ' fired below the cohort height');
            assert.strictEqual(fn(RATIFIED_BTC_HEIGHT, 'mainnet'), true, key + ' did not fire at the cohort height');
            assert.strictEqual(fn(RATIFIED_BTC_HEIGHT + 1, 'mainnet'), true, key + ' did not stay on above the cohort height');
        }
    });

    it('the cohort height is still in the FUTURE relative to the ratified TIME anchor era', function () {
        // The failure this guards is the one the re-pin had to avoid: pinning
        // the height half onto the calendar date of the TIME half. That date is past,
        // and a height in the past is not a flag day (a genesis replay applies the rule
        // from it, a long-running node never did, and they diverge at the first hash).
        // 961000 is the last boundary the chain has already crossed, so anything at or
        // below it is by definition retroactive.
        const CROSSED = registry.get('anchor_reward_activation.ANCHOR_REWARD_ACTIVATION').mainnet;
        assert.ok(RATIFIED_BTC_HEIGHT > CROSSED,
            'the ratified height cohort (' + RATIFIED_BTC_HEIGHT + ') is at or below the already-crossed ' +
            CROSSED + ' boundary, which arms it retroactively');
    });
});

describe('flag-day placeholder guard @regression @tier1', function () {
    it('SLASH_BURNS_PENDING_STAKE mainnet_block equals EQUIV_HEADER_ACTIVATION.mainnet (no duplicated-constant drift, #3134)', function () {
        // The gate is deliberately anchored to the EQUIV flag-day HEIGHT, but the literal
        // 961000 is duplicated in protocol_changes.js rather than derived from the shared map.
        // Bind the two so a re-arm of the EQUIV anchor cannot silently leave this gate behind.
        const equivMainnet = require(path.join(SRC, 'consensus', 'equivocation_header.js')).EQUIV_HEADER_ACTIVATION.mainnet;
        const row = pcTable.SLASH_BURNS_PENDING_STAKE;
        assert.ok(is020(row) && row.mainnet_block > 0, 'SLASH_BURNS_PENDING_STAKE must be registered with a mainnet_block gate');
        assert.strictEqual(row.mainnet_block, equivMainnet,
            'SLASH_BURNS_PENDING_STAKE mainnet_block must equal EQUIV_HEADER_ACTIVATION.mainnet; divergence reopens the burn-pending window the gate exists to close');
    });

    it('SLASH_ORACLE_ROUND_DISCRIMINATED mainnet_block equals EQUIV_HEADER_ACTIVATION.mainnet', function () {
        // Same duplicated-literal hazard as SLASH_BURNS_PENDING_STAKE above: the XORACLE round-discrimination
        // gate is anchored to the EQUIV flag-day HEIGHT, so a re-arm of that anchor must not
        // leave this gate behind on the old height, which would reopen the window where an
        // honest price validator's two distinct rounds at one BTC tip burn its whole bond.
        const equivMainnet = require(path.join(SRC, 'consensus', 'equivocation_header.js')).EQUIV_HEADER_ACTIVATION.mainnet;
        const row = pcTable.SLASH_ORACLE_ROUND_DISCRIMINATED;
        assert.ok(is020(row) && row.mainnet_block > 0, 'SLASH_ORACLE_ROUND_DISCRIMINATED must be registered with a mainnet_block gate');
        assert.strictEqual(row.mainnet_block, equivMainnet,
            'SLASH_ORACLE_ROUND_DISCRIMINATED mainnet_block must equal EQUIV_HEADER_ACTIVATION.mainnet');
    });
});

// NOTE: xchain-documentation/protocol/constants.js is deliberately NOT in
// this loop. Its `mainnet: 963000` substring is vacuously satisfied by
// ARCHIVE_REWARD_ACTIVATION, so a substring check on the docs file could never fail
// for the retraction gate. The docs arm is asserted by named export below instead.
//
// Each entry is a sibling repo, the registry row the cohort member is, and (for
// the one member that still has a logic module, the anchor-reward gate) the
// sibling's copy of that module: a module carries no height of its own any more
// (it resolves `<stem>.<EXPORT>` through the sibling's src/consensus/gate_registry),
// so the height is asserted on the row text under
// src/consensus/gate_registry/shared_rows_*.js, the same source of truth the
// callers read, while a surviving module is still swept for the placeholder. The
// retraction, price-tally and relay shims went with W5 in every repo (their
// callers read the row by key), so those entries name the row alone.
const SIBLING_FILES = [
    ['../../../../xchain-hub', 'anchor_reward_activation.ARCHIVE_REWARD_ACTIVATION', 'src/consensus/gates/anchor_reward_gate.js'],
    ['../../../../xchain-hub', 'retraction_signing_activation.RETRACTION_SIGNING_ACTIVATION', null],
    ['../../../../xchain-explorer', 'retraction_signing_activation.RETRACTION_SIGNING_ACTIVATION', null],
    // the PRICE v0 signature-tally gate rides the SAME ratified 963000
    // anchor, so a future re-anchor has to move it along with the pair above.
    ['../../../../xchain-hub', 'price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION', null],
    // the ATTEST relay gate rides it too and was listed
    // nowhere here, so the and repins could not have failed on it.
    ['../../../../xchain-hub', 'attest_relay_activation.ATTEST_RELAY_ACTIVATION', null],
];

// The text of one registry row in a sibling checkout: the `addGate('<key>', ...)`
// call through its closing `});`, found in whichever shared_rows_N.js part holds
// it. Text rather than require(): a sibling's registry entry loads that repo's
// config module, which this guard has no business evaluating. Throws naming the
// key when no part carries the row, because a sibling that dropped it is exactly
// the regression this sweep exists to catch.
function siblingRegistryRow(siblingDir, key) {
    const dir = path.join(siblingDir, 'src', 'consensus', 'gate_registry');
    const parts = fs.readdirSync(dir).filter(f => /^shared_rows_\d+\.js$/.test(f)).sort();
    const open = "addGate('" + key + "',";
    for (const part of parts) {
        const text = fs.readFileSync(path.join(dir, part), 'utf8');
        const at = text.indexOf('\n' + open);
        if (at < 0) continue;
        const close = text.indexOf('\n});', at);
        assert.ok(close > at, part + ' opens the row ' + key + ' and never closes it');
        return { part, text: text.slice(at + 1, close + 4) };
    }
    throw new Error('no shared_rows_N.js under ' + dir + ' carries the registry row ' + key);
}

describe('flag-day placeholder guard @regression @tier1', function () {
    // Cross-service sweep: resolved by monorepo-relative path, so this only runs in the
    // monorepo/aggregator checkout; standalone single-repo CI skips (unless a required-
    // sibling job sets XCHAIN_REQUIRE_SIBLINGS=1, where a missing sibling hard-fails).
    describe('sibling copies carry no placeholder regression', function () {
        for (const [repoRel, key, moduleRel] of SIBLING_FILES) {
            const repoName = repoRel.replace(/^(\.\.\/)+/, '');
            it(repoName + ' ' + key + ' has no 983000 placeholder and pins the derived height', function () {
                const repo = path.resolve(__dirname, repoRel);
                // The row's part file, or the module when one still exists: absent or a
                // lane symlink into a live main checkout skips, or fails naming why.
                const probe = moduleRel ? path.join(repo, moduleRel) : path.join(repo, 'src', 'consensus', 'gate_registry.js');
                const sibling = siblingCheckout(__dirname, probe);
                if (!sibling.usable) return skipOrFail(this, sibling, 'the placeholder sweep of ' + repoName + ' ' + key);
                if (moduleRel) {
                    const s = fs.readFileSync(probe, 'utf8');
                    assert.ok(!s.includes('983000'), probe + ' still carries the retired 983000 placeholder');
                }
                const row = siblingRegistryRow(repo, key);
                assert.ok(!row.text.includes('983000'),
                    row.part + ' row ' + key + ' still carries the retired 983000 placeholder');
                assert.ok(row.text.includes('mainnet: ' + RATIFIED_BTC_HEIGHT + ','),
                    row.part + ' row ' + key + ' must pin the derived mainnet height ' + RATIFIED_BTC_HEIGHT
                    + ' (the callers in ' + repoName + ' read it from there)');
            });
        }

        // Assert the retraction gate against the canonical inventory by NAMED
        // EXPORT, not by substring. The vendored copies claim to be byte-equal to the
        // RETRACTION_SIGNING_ACTIVATION map in xchain-documentation/protocol/constants.js;
        // this makes that claim capable of failing (a re-anchor that moves the copies while
        // the docs stay silent now trips CI).
        it('xchain-documentation/protocol/constants.js pins RETRACTION_SIGNING_ACTIVATION by named export, value-equal to the vendored copy', function () {
            const p = path.resolve(__dirname, '../../../../xchain-documentation/protocol/constants.js');
            const sibling = siblingCheckout(__dirname, p);
            if (!sibling.usable) return skipOrFail(this, sibling, 'the RETRACTION_SIGNING_ACTIVATION docs pin');
            const canon = require(p);
            assert.ok(canon.RETRACTION_SIGNING_ACTIVATION && typeof canon.RETRACTION_SIGNING_ACTIVATION === 'object',
                'constants.js must export a RETRACTION_SIGNING_ACTIVATION map (the canonical authority for the three vendored copies)');
            assert.strictEqual(canon.RETRACTION_SIGNING_ACTIVATION.mainnet, RATIFIED_BTC_HEIGHT,
                'canonical retraction mainnet height must be the ratified ' + RATIFIED_BTC_HEIGHT);
            const local = registry.get('retraction_signing_activation.RETRACTION_SIGNING_ACTIVATION');
            assert.deepStrictEqual(local, canon.RETRACTION_SIGNING_ACTIVATION,
                'the retraction_signing_activation registry row drifted from the canonical constants.js map');
        });
    });
});

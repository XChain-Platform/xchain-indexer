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
 * Unit: stallWedged() /status healthcheck discriminator
 *
 * The height-keyed BTC price-sync barrier defers the newest block on almost
 * every poll, so a healthy BTC-mainnet indexer is nearly always mid-barrier
 * (stallReason set) even though it advances every few seconds. stallWedged()
 * is what lets the container /status healthcheck reserve 503 for a real wedge
 * rather than restart-looping a functioning service.
 */

'use strict';

const assert = require('assert');
const { stallWedged, waitingOnFutureBlock, stallClassOf, atProcessableTip } = require('../../src/XChainIndexer');

describe('stallWedged() healthcheck discriminator', function () {
    const GRACE = 120000; // 2 min
    const NOW   = 1_000_000_000;

    it('no stallReason is never wedged, regardless of commit age', function () {
        assert.strictEqual(stallWedged(null, NOW - 999999999, GRACE, NOW), false);
        assert.strictEqual(stallWedged(null, null, GRACE, NOW), false);
    });

    it('a stall with no committed block yet is not wedged (slow initial catch-up gets grace)', function () {
        assert.strictEqual(stallWedged('price_sync_barrier', null, GRACE, NOW), false);
    });

    it('stalled but a block committed inside the grace window is NOT wedged (advancing-degraded)', function () {
        // committed 5s ago against a 2 min grace: the BTC steady state
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - 5000, GRACE, NOW), false);
    });

    it('stalled and no commit for longer than the grace window IS wedged', function () {
        // committed 10 min ago: mirror down / host fault
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - 600000, GRACE, NOW), true);
        assert.strictEqual(stallWedged('vm_executor_unavailable', NOW - 600000, GRACE, NOW), true);
    });

    it('the grace boundary is exclusive: exactly at grace is not yet wedged, one ms past is', function () {
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - GRACE, GRACE, NOW), false);
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - GRACE - 1, GRACE, NOW), true);
    });
});

/*
 * a block stamped in the FUTURE (Bitcoin permits ~2h ahead of median-time-past,
 * and miner clocks routinely run minutes fast) defers behind the time-keyed barriers until
 * wall clock reaches its timestamp. Nothing commits for the whole skew, so against a 120s
 * grace the indexer crossed the wedge threshold in two minutes and reported 503/unhealthy
 * over an entirely valid block, fleet-wide and simultaneously, with a restart achieving
 * nothing. Observed live on BTC testnet4 block 146590 (stamped 116.5 minutes ahead).
 */
describe('stallWedged() future-stamped-block deadline', function () {
    const GRACE = 120000;
    const NOW   = 1_000_000_000;
    const LONG_STALL = NOW - 600000;   // 10 min with no commit: wedged under the old rule

    it('a stall waiting on a still-future instant is NOT wedged, however long it has stalled', function () {
        assert.strictEqual(stallWedged('price_sync_barrier', LONG_STALL, GRACE, NOW, NOW + 1), false);
        // the real shape: a 116-minute skew, far past any grace window
        assert.strictEqual(stallWedged('price_sync_barrier', LONG_STALL, GRACE, NOW, NOW + 6_990_000), false);
    });

    it('once wall clock reaches the instant, the ordinary grace verdict applies again', function () {
        // the deadline has passed and the stall persists: the mirror really is stuck
        assert.strictEqual(stallWedged('price_sync_barrier', LONG_STALL, GRACE, NOW, NOW), true);
        assert.strictEqual(stallWedged('price_sync_barrier', LONG_STALL, GRACE, NOW, NOW - 1), true);
    });

    it('the deadline suppresses the WEDGE only, never invents one', function () {
        // still advancing (committed 5s ago): not wedged either way
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - 5000, GRACE, NOW, NOW + 60000), false);
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - 5000, GRACE, NOW, NOW - 60000), false);
        // no stall at all: a deadline cannot make one
        assert.strictEqual(stallWedged(null, LONG_STALL, GRACE, NOW, NOW + 60000), false);
    });

    it('a null/absent/non-finite deadline preserves the pre- verdict exactly', function () {
        for (const d of [undefined, null, NaN, Infinity, -Infinity, 'soon']) {
            assert.strictEqual(stallWedged('price_sync_barrier', LONG_STALL, GRACE, NOW, d), true,
                               'wedged verdict must survive deadline=' + String(d));
            assert.strictEqual(stallWedged('price_sync_barrier', NOW - 5000, GRACE, NOW, d), false,
                               'advancing verdict must survive deadline=' + String(d));
        }
    });

    it('barriers with no wall-clock deadline (host faults) still wedge', function () {
        // vm_executor_unavailable and the presence/snapshot barriers pass null by design:
        // a host fault has no instant at which it clears on its own.
        assert.strictEqual(stallWedged('vm_executor_unavailable', LONG_STALL, GRACE, NOW, null), true);
        assert.strictEqual(stallWedged('call_presence_barrier',   LONG_STALL, GRACE, NOW, null), true);
    });
});

/*
 * Telling the healthy future-stamped-block wait apart from degradation.
 *
 * Measured on BTC testnet4: the miner stamps each block ~20 min ahead of the previous
 * one, riding the consensus 2-hour future-time cap, so the time-keyed barriers hold the
 * head block until wall clock reaches its stamp. Lag pins at ~6 blocks forever and the
 * indexer commits each block in milliseconds the moment it becomes processable. On the
 * old surface that reads as isSynced:false + degraded:true + a named stallReason, i.e.
 * a permanent fault to any monitor. These pin the discriminators that say otherwise.
 */
describe('waitingOnFutureBlock() / stallClassOf() / atProcessableTip()', function () {
    const GRACE = 120000;
    const NOW   = 1_000_000_000;
    const LONG_STALL = NOW - 900000;   // 15 min with no commit
    const RECENT     = NOW - 5000;

    describe('waitingOnFutureBlock()', function () {
        it('a still-future clear instant with a stall set is a future-block wait', function () {
            assert.strictEqual(waitingOnFutureBlock('anchor_attest_barrier', NOW + 1, NOW), true);
            // the real shape: a 16 minute skew
            assert.strictEqual(waitingOnFutureBlock('anchor_attest_barrier', NOW + 960000, NOW), true);
        });

        it('no stall is never a future-block wait, however far ahead the instant', function () {
            assert.strictEqual(waitingOnFutureBlock(null, NOW + 960000, NOW), false);
        });

        it('a reached or passed instant is no longer a wait', function () {
            assert.strictEqual(waitingOnFutureBlock('anchor_attest_barrier', NOW, NOW), false);
            assert.strictEqual(waitingOnFutureBlock('anchor_attest_barrier', NOW - 1, NOW), false);
        });

        it('barriers with no wall-clock instant are never a future-block wait', function () {
            for (const d of [undefined, null, NaN, Infinity, -Infinity, 'soon']) {
                assert.strictEqual(waitingOnFutureBlock('call_presence_barrier', d, NOW), false,
                                   'must not claim a future wait for stallClearsAt=' + String(d));
            }
        });
    });

    describe('stallClassOf()', function () {
        it('no stall classifies as none', function () {
            assert.strictEqual(stallClassOf(null, RECENT, GRACE, NOW, null), 'none');
            assert.strictEqual(stallClassOf(null, LONG_STALL, GRACE, NOW, NOW + 960000), 'none');
        });

        it('the testnet4 steady state classifies as future_block_wait, not wedged', function () {
            // no commit for 15 min against a 2 min grace, but the head block is stamped
            // 16 min ahead: the old surface called this a wedge-shaped degradation
            assert.strictEqual(stallClassOf('anchor_attest_barrier', LONG_STALL, GRACE, NOW, NOW + 960000),
                               'future_block_wait');
        });

        it('an advancing barrier defer with no wall-clock instant classifies as barrier_defer', function () {
            assert.strictEqual(stallClassOf('price_sync_barrier', RECENT, GRACE, NOW, null), 'barrier_defer');
        });

        it('a real wedge still classifies as wedged', function () {
            assert.strictEqual(stallClassOf('vm_executor_unavailable', LONG_STALL, GRACE, NOW, null), 'wedged');
            // and once the clear instant has passed and the stall persists
            assert.strictEqual(stallClassOf('anchor_attest_barrier', LONG_STALL, GRACE, NOW, NOW - 1), 'wedged');
        });

        it('the class never contradicts stallWedged()', function () {
            const cases = [
                ['anchor_attest_barrier', LONG_STALL, NOW + 960000],
                ['anchor_attest_barrier', LONG_STALL, NOW - 1],
                ['price_sync_barrier',    RECENT,     null],
                ['vm_executor_unavailable', LONG_STALL, null],
                [null,                    LONG_STALL, null]
            ];
            for (const [reason, committedAt, clearsAt] of cases) {
                const wedged = stallWedged(reason, committedAt, GRACE, NOW, clearsAt);
                const cls    = stallClassOf(reason, committedAt, GRACE, NOW, clearsAt);
                assert.strictEqual(cls === 'wedged', wedged,
                                   `class ${cls} disagrees with stallWedged=${wedged} for ${String(reason)}`);
            }
        });
    });

    describe('atProcessableTip()', function () {
        it('level with the decoder tip is at the processable tip', function () {
            assert.strictEqual(atProcessableTip(true, null, null, NOW), true);
        });

        it('a future-stamped block in the way still counts as caught up', function () {
            // the point of the field: lag is 6, isSynced is false, and the indexer holds
            // every block consensus permits it to hold
            assert.strictEqual(atProcessableTip(false, 'anchor_attest_barrier', NOW + 960000, NOW), true);
        });

        it('an ordinary catch-up or mirror-lag defer is NOT at the processable tip', function () {
            assert.strictEqual(atProcessableTip(false, null, null, NOW), false);
            assert.strictEqual(atProcessableTip(false, 'price_sync_barrier', null, NOW), false);
            assert.strictEqual(atProcessableTip(false, 'anchor_attest_barrier', NOW - 1, NOW), false);
        });
    });
});

/*
 * Every barrier keys its stallClearsAt on ITS OWN grace field.
 *
 * The call barrier borrowed matchWatermarkGraceS long after _callSyncSatisfied
 * had been decoupled onto callWatermarkGraceS. Both constants are 120s today, so
 * the emitted value was identical and no behavioural test could see the slip.
 * _barrierClearsAt coerces an unknown field to grace 0, so a rename fails silently
 * too. Pin the mapping by source text, which is the only place the pairing exists.
 */
describe('barrier stallClearsAt grace-field mapping @regression', function () {
    const fs   = require('fs');
    const path = require('path');

    const INDEXER_SRC = fs.readFileSync(
        path.resolve(__dirname, '../../src/XChainIndexer.js'), 'utf8');
    const SYNC_SRC = fs.readFileSync(
        path.resolve(__dirname, '../../src/hub_db_sync.js'), 'utf8');

    // Every `this.stallReason = '<name>';` in the block loop is immediately followed by
    // the matching `this.stallClearsAt = ...;`, so a non-greedy pair scan reads the
    // wiring exactly rather than guessing at a line window.
    //
    // The scan reads the HEIGHT-AWARE helper as well as the plain one, because a re-keyed
    // barrier still has to name which grace it would use below its activation. It does NOT
    // accept a bare `_barrierClearsAt` on a re-keyed reason silently: the two helper names
    // are distinguished below, so dropping the height-awareness from a call site is a red
    // rather than a rename that slides through.
    function graceWiring() {
        const pairs = [];
        const re = /this\.stallReason = '(\w+)';[\s\S]*?this\.stallClearsAt\s*=\s*([^;]+);/g;
        let m;
        while ((m = re.exec(INDEXER_SRC)) !== null) {
            const expr  = m[2];
            const plain  = /_barrierClearsAt\(blockTime,\s*'([A-Za-z]+)'\)/.exec(expr);
            const height = /_barrierClearsAtHeightAware\(blockTime,\s*'([A-Za-z]+)',\s*blockToParse\)/.exec(expr);
            // The anchor barrier reads its grace through a BOUND-aware sibling, because its
            // predicate opens at min(blockTime, horizonBound) + grace. The field name still
            // travels in the call site, which is the pairing this scan exists to pin.
            const anchor = /_anchorBarrierClearsAt\(\s*\n?\s*blockTime,\s*anchorHorizonBound,\s*blockToParse,\s*'([A-Za-z]+)'\)/.exec(expr);
            // The direct-hub-DB call barrier has no HubDbSync to read a grace off, so it
            // keys on the indexer's own resolved field through its own helper. Map it to
            // that field so this test still pins WHICH grace the barrier uses.
            const direct = /_directCallBarrierClearsAt\(blockTime\)/.test(expr);
            let field = null, kind = 'null';
            if (height)      { field = height[1]; kind = 'height-aware'; }
            else if (anchor) { field = anchor[1]; kind = 'bound-aware'; }
            else if (plain)  { field = plain[1];  kind = 'clock'; }
            else if (direct) { field = 'directCallGraceS'; kind = 'clock'; }
            pairs.push([m[1], field, kind]);
        }
        return pairs;
    }

    // stallReason -> [grace field, how stallClearsAt is computed], for EVERY reason in the
    // file and not a filtered subset.
    //
    // The filter this list replaced took `graceWiring()` down to eight curated reasons, which
    // left bridge_sync_barrier, policy_sync_barrier, attest_response_sync_barrier and
    // bridge_proof_barrier unpinned: a new barrier, or a re-keyed one, could drop its grace
    // wiring entirely and this suite stayed green. That is the exact drift the scan exists to
    // catch, so the list is now exhaustive and a new stallReason FAILS here until it is added.
    //
    // 'height-aware' means the barrier was re-keyed onto the admission height watermark and
    // reports NO clear instant above its activation, which is what lets a hold accumulate and
    // the 900 s ceiling fire on a stall that is now genuine mirror lag.
    const EXPECTED = [
        ['price_sync_barrier',              null,                          'null'],          // height case can clear early
        ['price_sync_barrier',              'priceWatermarkGraceS',        'height-aware'],
        ['oracle_sync_barrier',             'oracleWatermarkGraceS',       'height-aware'],
        ['match_sync_barrier',              'matchWatermarkGraceS',        'height-aware'],
        ['call_sync_barrier',               'callWatermarkGraceS',         'height-aware'],
        ['bridge_sync_barrier',             'bridgeWatermarkGraceS',       'height-aware'],
        ['policy_sync_barrier',             'policyWatermarkGraceS',       'height-aware'],
        // Direct-hub-DB twin of call_sync_barrier. A null here (no watermark to key on)
        // is what makes such a barrier wedge forever: it leaves no time-keyed escape at
        // all. This one has one, resolved onto the indexer from the SAME frozen call
        // grace hub_db_sync uses.
        ['call_presence_barrier',           'directCallGraceS',            'clock'],
        ['anchor_attest_barrier',           'anchorAttestWatermarkGraceS', 'bound-aware'],
        ['attest_response_sync_barrier',    'attestResponseWatermarkGraceS', 'height-aware'],
        ['snapshot_sync_barrier',           null,                          'null'],          // presence, not wall clock
        // Host faults, not mirror barriers: none of them has a clock instant to name, and a
        // grace field appearing on one would be a category error rather than a drift.
        ['vm_executor_unavailable',         null,                          'null'],
        ['anchor_reward_proof_unavailable', null,                          'null'],
        ['bridge_proof_barrier',            null,                          'null'],
        ['rollcall_proof_unavailable',      null,                          'null']
    ];

    it('each barrier keys stallClearsAt on its own grace field', function () {
        assert.deepStrictEqual(graceWiring(), EXPECTED,
            'barrier-to-grace wiring drifted. Borrowing a sibling barrier\'s grace ' +
            'mis-times the /status wedge discriminator the moment the two constants ' +
            'diverge or a regtest env override moves one, and both are 120s today so ' +
            'no behavioural assertion can see the slip. A re-keyed barrier that lost its ' +
            'height-aware helper reads as a clock barrier here, which is the other half.');
    });

    it('every re-keyed barrier reports NO clear instant above the admission activation', function () {
        // The height rule removes t(B) from the predicate, so there is no instant wall clock
        // can reach that opens it. Reporting one anyway keeps waitingOnFutureBlock() answering
        // 'future_block_wait', keeps nextBarrierHold() at null and makes the 900 s ceiling
        // unreachable on exactly the barrier whose stall is now remediable.
        const reKeyed = EXPECTED.filter(e => e[2] === 'height-aware' || e[2] === 'bound-aware');
        assert.strictEqual(reKeyed.length, 8, 'eight of the eleven hold points are re-keyed onto a height');
        assert.ok(/_barrierClearsAtHeightAware\(blockTime, graceField, blockHeight\)\{[\s\S]{0,400}?_mirrorAdmissionActiveAt\(blockHeight\)\) return null;/.test(INDEXER_SRC),
            'the height-aware helper must return null while the admission consumer is armed');
        assert.ok(/_anchorBarrierClearsAt\(blockTime, horizonBound, blockHeight, graceField\)\{[\s\S]{0,400}?_mirrorAdmissionActiveAt\(blockHeight\)\) return null;/.test(INDEXER_SRC),
            'the anchor barrier\'s bound-aware helper must return null while the admission consumer is armed');
    });

    it('every grace field named by a barrier exists on the HubDbSync instance', function () {
        // _barrierClearsAt coerces an unresolvable field to grace 0, so a rename that
        // misses a call site degrades silently rather than throwing.
        for (const [reason, field] of EXPECTED) {
            if (field === null) continue;
            // directCallGraceS lives on the indexer, not on HubDbSync: the direct barrier
            // runs precisely when there is no HubDbSync instance to read one off.
            const src = (field === 'directCallGraceS') ? INDEXER_SRC : SYNC_SRC;
            assert.ok(new RegExp('this\\.' + field + '\\s*=').test(src),
                field + ' (used by ' + reason + ') is not assigned in its owning module');
        }
    });

    it('the direct call barrier resolves its grace from the frozen call constant', function () {
        // The whole point of the escape is that the direct path and the mirrored path
        // open on the SAME number. A private default here, or a resolver that skips
        // resolveWatermarkGrace, would let two operators of one chain inject a cross-chain
        // call at different blocks.
        assert.ok(/resolveWatermarkGrace\(\s*\n?\s*HUB_SYNC_WATERMARK_GRACE_S\.call,\s*'HUB_SYNC_CALL_GRACE_S'/.test(INDEXER_SRC),
            'directCallGraceS must be resolved through hub_db_sync resolveWatermarkGrace on the frozen call grace');
        assert.ok(/module\.exports\.resolveWatermarkGrace\s*=/.test(SYNC_SRC),
            'hub_db_sync must export resolveWatermarkGrace for the direct barrier to share it');
    });

    // Curated, not derived from every `_release*Waiters` definition:
    // _releaseSnapshotWaiters is deliberately driven off the CROSS_CHAIN_TABLES
    // content refresh instead of the watermark, so a blanket "every waiter
    // method fires here" rule would be wrong on its face. A barrier missing
    // from _advanceWatermark blocks its waiters for the full poll timeout on
    // every advance.
    const REQUIRED_WATERMARK_RELEASES = [
        '_releasePriceWaiters',
        '_releasePriceTimeWaiters',
        '_releaseOracleWaiters',
        '_releaseMatchWaiters',
        '_releaseCallWaiters',
        '_releaseAnchorAttestWaiters',
        '_releaseAttestResponseWaiters',
    ];

    it('every curated barrier registers its release call inside _advanceWatermark', function () {
        const m = /_advanceWatermark\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(SYNC_SRC);
        assert.ok(m, '_advanceWatermark method not found in hub_db_sync.js');
        const body = m[1];
        for (const call of REQUIRED_WATERMARK_RELEASES) {
            assert.ok(body.includes(call + '('),
                call + '() is missing from _advanceWatermark; its waiters would block for the full poll timeout on every advance');
        }
    });

    // Above the activation the HEIGHT watermark is what satisfies those same waiters, and it
    // moves on frames whose `ts` did not. A barrier missing from the height release path
    // therefore sits out its whole 60 s timeout on every height advance, which is the same
    // defect as the one above on the axis the family actually opens on.
    it('every curated barrier registers its release call inside _releaseHeightWaiters', function () {
        const m = /_releaseHeightWaiters\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(SYNC_SRC);
        assert.ok(m, '_releaseHeightWaiters method not found in hub_db_sync.js');
        const body = m[1];
        for (const call of REQUIRED_WATERMARK_RELEASES) {
            assert.ok(body.includes(call + '('),
                call + '() is missing from _releaseHeightWaiters; its waiters would block for the full poll timeout on every height advance');
        }
    });
});

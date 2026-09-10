// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Stream-watermark stall recovery.
//
// The mirror's transport watchdog proves FRAMES are arriving; nothing proved that any
// of them still moved the stream watermark. A watermark frozen while heartbeats keep
// landing holds every match/oracle/call/price barrier open-endedly with the socket, the
// logs and the watchdog all reading healthy, and the block loop's hold ceiling is both
// block-driven and far longer than such a freeze lasts. The detector under test is the
// mirror's own bound: hub tip ahead + watermark unmoved => force one resync, and if that
// does not move it either, hand the process to its supervisor under a named reason.
//
// Fake timers throughout: every window here is minutes long and the whole point is what
// happens at their boundaries.

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');
const {
    HUB_SYNC_WATERMARK_STALL_S,
    HUB_SYNC_WATERMARK_STALL_EXIT_S,
    resolveWatermarkStallMs,
    watermarkStallVerdict
} = require('../../src/hub_db_sync.js');

const STALL_MS = 60000;      // stage 1 window used by the wiring cases
const EXIT_MS  = 90000;      // stage 2 window used by the wiring cases

// A sync with no socket, no DB reads and both windows short enough to step over with
// fake timers. running/enabled are set by hand because start() would open a socket.
function makeSync(overrides) {
    const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, Object.assign({
        hubUrl:                'http://hub.test',
        watermarkStallMs:      STALL_MS,
        watermarkStallExitMs:  EXIT_MS
    }, overrides || {}));
    sync.running = true;
    return sync;
}

// Put the mirror in the steady state the detector is armed for: bootstrapped, a
// watermark that has advanced once, and a hub that keeps heartbeating past it.
function armStalled(sync, { hubTip = 2000, watermark = 1000 } = {}) {
    sync._bootstrapDrained       = true;
    sync.streamWatermark         = watermark;
    sync._lastWatermarkAdvanceAt = Date.now();
    sync._hubTipTs               = hubTip;
    return sync;
}

describe('HubDbSync stream-watermark stall recovery @regression @tier1', function () {

    // ── the verdict itself ────────────────────────────────────────────────────
    describe('watermarkStallVerdict', function () {
        const base = {
            stallMs: STALL_MS, exitMs: EXIT_MS,
            pollMode: false, schemaMismatch: false,
            lastAdvanceAt: 0, resyncAt: null,
            hubTipTs: 2000, streamWatermark: 1000
        };
        const at = (now, over) => watermarkStallVerdict(Object.assign({}, base, over || {}), now);

        it('is ok while the stall window has not elapsed, and resyncs exactly at it', function () {
            assert.strictEqual(at(STALL_MS - 1), 'ok');
            assert.strictEqual(at(STALL_MS), 'resync', 'the boundary is inclusive');
        });

        it('does not fire while the hub tip is at or behind our watermark', function () {
            // A quiet hub produces nothing new, so a watermark that does not move is
            // correct. This is the comparison that separates a stall from an idle chain.
            assert.strictEqual(at(STALL_MS * 10, { hubTipTs: 1000 }), 'ok');
            assert.strictEqual(at(STALL_MS * 10, { hubTipTs: 900 }),  'ok');
        });

        it('does not fire before the mirror has ever certified a watermark', function () {
            assert.strictEqual(at(STALL_MS * 10, { lastAdvanceAt: null }), 'ok',
                'a cold start that never drained is the hold ceiling to bound, not this');
        });

        it('does not fire in poll mode or under a schema mismatch', function () {
            assert.strictEqual(at(STALL_MS * 10, { pollMode: true }),       'ok');
            assert.strictEqual(at(STALL_MS * 10, { schemaMismatch: true }), 'ok');
        });

        it('after a resync, times the exit window from the REMEDY, not the freeze', function () {
            const r = { resyncAt: STALL_MS };
            assert.strictEqual(at(STALL_MS + EXIT_MS - 1, r), 'ok');
            assert.strictEqual(at(STALL_MS + EXIT_MS, r),     'exit');
        });

        it('0 disables: stallMs 0 detects nothing, exitMs 0 resyncs but never exits', function () {
            assert.strictEqual(at(STALL_MS * 10, { stallMs: 0 }), 'ok');
            assert.strictEqual(at(STALL_MS * 10, { exitMs: 0, resyncAt: STALL_MS }), 'ok');
        });
    });

    // ── the window resolver ───────────────────────────────────────────────────
    describe('resolveWatermarkStallMs', function () {
        const KEY = 'HUB_SYNC_WATERMARK_STALL_S';
        let saved;
        beforeEach(function () { saved = process.env[KEY]; delete process.env[KEY]; });
        afterEach(function () {
            if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved;
        });

        it('defaults to the frozen constants, and the exit window clears a full re-drain', function () {
            assert.strictEqual(resolveWatermarkStallMs(undefined, KEY, HUB_SYNC_WATERMARK_STALL_S),
                HUB_SYNC_WATERMARK_STALL_S * 1000);
            assert.ok(HUB_SYNC_WATERMARK_STALL_EXIT_S >= HUB_SYNC_WATERMARK_STALL_S,
                'the post-remedy window must be at least as long as the detection window: a ' +
                're-bootstrap drain is the slowest legitimate thing it has to sit through');
        });

        it('reads the env override, and 0 is the off switch', function () {
            process.env[KEY] = '45';
            assert.strictEqual(resolveWatermarkStallMs(undefined, KEY, HUB_SYNC_WATERMARK_STALL_S), 45000);
            assert.strictEqual(resolveWatermarkStallMs('0', KEY, HUB_SYNC_WATERMARK_STALL_S), 0);
        });

        it('falls back with a warning on an unusable value rather than throwing', function () {
            const log = sinon.stub(console, 'log');
            try {
                for (const bad of ['soon', '-5', '1.5']) {
                    assert.strictEqual(resolveWatermarkStallMs(bad, KEY, HUB_SYNC_WATERMARK_STALL_S),
                        HUB_SYNC_WATERMARK_STALL_S * 1000);
                }
                assert.strictEqual(log.callCount, 3, 'each bad value warns');
            } finally { log.restore(); }
        });
    });

    // ── the wiring, on fake timers ────────────────────────────────────────────
    describe('_checkWatermarkStall wiring', function () {
        let clock, errStub;

        beforeEach(function () {
            clock   = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
            errStub = sinon.stub(console, 'error');
            sinon.stub(console, 'warn');
        });

        afterEach(function () {
            sinon.restore();                                // also restores the fake clock
        });

        it('heartbeats flowing, watermark frozen, hub tip advancing => one resync, no exit', function () {
            const fatal = sinon.spy();
            const sync  = armStalled(makeSync({ onFatalStall: fatal }));
            const drive = sinon.stub(sync, '_driveResync');

            clock.tick(STALL_MS - 1);
            assert.strictEqual(sync._checkWatermarkStall(), 'ok');
            assert.strictEqual(drive.callCount, 0);

            clock.tick(1);
            assert.strictEqual(sync._checkWatermarkStall(), 'resync');
            assert.strictEqual(drive.callCount, 1, 'stage 1 forces a subscribe-then-bootstrap');
            assert.strictEqual(fatal.callCount, 0, 'stage 1 must not end the process');

            // Sampling again inside the exit window must not re-drive: the latch makes the
            // remedy one-per-episode so stage 2 measures the remedy, not a second freeze.
            clock.tick(EXIT_MS - 1);
            assert.strictEqual(sync._checkWatermarkStall(), 'ok');
            assert.strictEqual(drive.callCount, 1);
            assert.strictEqual(fatal.callCount, 0);
        });

        it('still frozen after the resync => the bounded exit fires with a named reason', function () {
            const fatal = sinon.spy();
            const sync  = armStalled(makeSync({ onFatalStall: fatal }));
            sinon.stub(sync, '_driveResync');

            clock.tick(STALL_MS);
            assert.strictEqual(sync._checkWatermarkStall(), 'resync');

            clock.tick(EXIT_MS - 1);
            assert.strictEqual(sync._checkWatermarkStall(), 'ok', 'the window is not up yet');
            assert.strictEqual(fatal.callCount, 0);

            clock.tick(1);
            assert.strictEqual(sync._checkWatermarkStall(), 'exit');
            assert.strictEqual(fatal.callCount, 1, 'stage 2 hands the process to its supervisor');

            const reason = fatal.firstCall.args[0];
            assert.ok(/hub-mirror stream watermark stalled/.test(reason),
                'the reason names the fault, not just a code: ' + reason);
            assert.ok(reason.indexOf(String(sync.streamWatermark)) !== -1 &&
                      reason.indexOf(String(sync._hubTipTs)) !== -1,
                'the reason carries both sides of the gap it measured: ' + reason);
            assert.ok(/HUB_SYNC_WATERMARK_STALL_EXIT_S/.test(reason),
                'the reason names the knob that timed it: ' + reason);
        });

        it('a watermark that is moving fires nothing at all', function () {
            const fatal = sinon.spy();
            const sync  = armStalled(makeSync({ onFatalStall: fatal }));
            const drive = sinon.stub(sync, '_driveResync');

            // The hub tip advances and the mirror keeps up: every sample is ok, forever.
            for (let i = 0; i < 20; i++) {
                clock.tick(STALL_MS);
                sync._hubTipTs += 30;
                sync._advanceWatermark(sync.streamWatermark + 30);
                assert.strictEqual(sync._checkWatermarkStall(), 'ok');
            }
            assert.strictEqual(drive.callCount, 0, 'a healthy mirror is never re-driven');
            assert.strictEqual(fatal.callCount, 0);
        });

        it('an advance mid-episode disarms a pending exit', function () {
            const fatal = sinon.spy();
            const sync  = armStalled(makeSync({ onFatalStall: fatal }));
            sinon.stub(sync, '_driveResync');

            clock.tick(STALL_MS);
            assert.strictEqual(sync._checkWatermarkStall(), 'resync');

            // The forced resync worked: the re-bootstrap drained and the mirror caught up.
            clock.tick(EXIT_MS - 1);
            sync._advanceWatermark(sync._hubTipTs);
            assert.strictEqual(sync._watermarkStallResyncAt, null, 'the latch clears on a real advance');

            clock.tick(EXIT_MS * 2);
            assert.strictEqual(sync._checkWatermarkStall(), 'ok',
                'no exit: the recovery is what the whole detector exists to produce');
            assert.strictEqual(fatal.callCount, 0);
        });

        it('a PARTIAL advance re-arms stage 1 rather than falling through to the exit', function () {
            // The remedy moved the watermark but not up to the hub tip. That is progress,
            // so the process must not be killed on the old episode's clock; it earns a
            // fresh detection window, and only a second full freeze escalates again.
            const fatal = sinon.spy();
            const sync  = armStalled(makeSync({ onFatalStall: fatal }));
            sinon.stub(sync, '_driveResync');

            clock.tick(STALL_MS);
            assert.strictEqual(sync._checkWatermarkStall(), 'resync');

            clock.tick(EXIT_MS - 1);
            sync._advanceWatermark(1500);                  // still short of the 2000 tip

            clock.tick(STALL_MS);
            assert.strictEqual(sync._checkWatermarkStall(), 'resync', 'stage 1 again, not stage 2');
            assert.strictEqual(fatal.callCount, 0, 'progress is never charged to the fatal window');
        });

        it('without a fatal handler the mirror keeps re-driving instead of exiting', function () {
            const sync  = armStalled(makeSync());          // no onFatalStall: the vendored-consumer shape
            const drive = sinon.stub(sync, '_driveResync');

            clock.tick(STALL_MS);
            assert.strictEqual(sync._checkWatermarkStall(), 'resync');
            clock.tick(EXIT_MS);
            assert.strictEqual(sync._checkWatermarkStall(), 'exit');
            assert.strictEqual(drive.callCount, 2, 'stage 2 re-drives when nothing will restart it');
        });

        it('a stopped or disabled mirror never fires', function () {
            const sync = armStalled(makeSync());
            const drive = sinon.stub(sync, '_driveResync');
            sync.running = false;
            clock.tick(STALL_MS * 10);
            assert.strictEqual(sync._checkWatermarkStall(), 'ok');
            assert.strictEqual(drive.callCount, 0);
        });

        it('the timer samples several times per window and unrefs itself', function () {
            const sync = armStalled(makeSync());
            const check = sinon.stub(sync, '_checkWatermarkStall').returns('ok');
            sync._startStallDetector();
            try {
                assert.ok(sync._stallTimer, 'a detector is running');
                assert.ok(sync._stallCheckIntervalMs() <= STALL_MS / 4,
                    'the sampler must not be able to miss a window');
                clock.tick(STALL_MS);
                assert.ok(check.callCount >= 4, 'sampled ' + check.callCount + ' times per window');
            } finally { sync._stopStallDetector(); }
            assert.strictEqual(sync._stallTimer, null);
        });

        it('a zero stall window starts no detector at all', function () {
            const sync = makeSync({ watermarkStallMs: 0 });
            sync._startStallDetector();
            assert.strictEqual(sync._stallTimer, null);
        });
    });

    // ── the evidence the detector runs on ─────────────────────────────────────
    describe('hub tip recording', function () {
        it('_noteHubTip keeps the newest tip and ignores junk and regressions', function () {
            const sync = makeSync();
            sync._noteHubTip(1000);
            sync._noteHubTip(900);
            assert.strictEqual(sync._hubTipTs, 1000, 'monotonic');
            sync._noteHubTip('nope');
            sync._noteHubTip(null);
            assert.strictEqual(sync._hubTipTs, 1000, 'non-numeric tips are ignored');
            sync._noteHubTip(1100);
            assert.strictEqual(sync._hubTipTs, 1100);
        });

        it('a refused heartbeat still records the tip, which is what makes the stall visible', async function () {
            // Not bootstrapped: the gate refuses to advance the watermark. If the refused
            // tip were dropped too, hubTipTs would equal streamWatermark forever and the
            // detector could never tell this apart from a hub with nothing to send.
            const sync = makeSync();
            sync._bootstrapDrained = false;
            sync._noteHubTip(5000);
            if (sync._bootstrapDrained && !sync._schemaMismatchSeen) sync._advanceWatermark(5000);
            assert.strictEqual(sync.streamWatermark, 0, 'the gate held');
            assert.strictEqual(sync._hubTipTs, 5000, 'the tip was still recorded');
        });

        it('mirrorStatus surfaces the gap the detector measures', function () {
            const sync = armStalled(makeSync());
            const status = sync.mirrorStatus();
            assert.strictEqual(status.hubTipTs, 2000);
            assert.strictEqual(status.streamWatermark, 1000);
            assert.strictEqual(typeof status.watermarkFrozenMs, 'number');
        });
    });

    // ── the remedy must not be throttled away ─────────────────────────────────
    describe('_driveResync is reachable past requestResync throttling', function () {
        it('a block-loop resync inside the ceiling window cannot swallow the stall remedy', function () {
            const sync = armStalled(makeSync());
            const warn = sinon.stub(console, 'warn');
            const err  = sinon.stub(console, 'error');
            try {
                sync.ws = { terminate: sinon.spy() };

                assert.strictEqual(sync.requestResync('block loop'), true);
                assert.strictEqual(sync.requestResync('block loop again'), false,
                    'the hold-ceiling throttle is intact');

                // The detector goes around it: the stage-2 window it is about to time is
                // only meaningful if the stage-1 retry actually happened.
                const before = sync.forcedResyncCount;
                sync._lastWatermarkAdvanceAt = Date.now() - sync.watermarkStallMs;
                assert.strictEqual(sync._checkWatermarkStall(), 'resync');
                assert.strictEqual(sync.forcedResyncCount, before + 1, 'the resync really ran');
            } finally { warn.restore(); err.restore(); }
        });
    });
});

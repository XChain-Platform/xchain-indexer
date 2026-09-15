// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The hub config overlay's live poll: a committed seq advance never applies a consensus
// param, overlapping ticks do not stack, a watermark-only advance re-applies, and a
// regressed hub resets the cursor.
// Part of the hub config overlay suite; see ../config.test.js.

const assert = require('assert');
const sinon = require('sinon');
const { makeIndexer, restoreOverlay } = require('./helpers/overlay_indexer.js');

let indexer;

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    it('poll advances the committed seq but never applies a consensus param', async function () {
        indexer = makeIndexer();
        let localFee = indexer.config.EXPIRATION_FEE_PER_DAY;
        let clock = sinon.useFakeTimers();
        try {
            // Startup: seq 5.
            let hubStub = { configEnabled: true, getAllConfigs:sinon.stub() };
            hubStub.getAllConfigs.onCall(0).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': { EXPIRATION_FEE_PER_DAY: '0.00010000' } } } }, seq: 5
            });
            indexer.hubClient = hubStub;
            await indexer.applyHubConfigOverlay();
            assert.strictEqual(indexer.lastHubConfigSeq, 5);
            assert.strictEqual(indexer.config.EXPIRATION_FEE_PER_DAY, localFee);

            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '60000';
            indexer.startHubConfigPolling();

            // Tick 1: same seq (5); must NOT re-apply (stale guard).
            hubStub.getAllConfigs.onCall(1).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': { EXPIRATION_FEE_PER_DAY: '0.99999999' } } } }, seq: 5
            });
            await clock.tickAsync(60000);
            assert.strictEqual(indexer.lastHubConfigSeq, 5, 'unchanged seq must not advance');

            // Tick 2: seq advances to 6. Bookkeeping updates, but the consensus param the hub
            // pushes is still ignored (no soft fork even across a committed re-apply).
            hubStub.getAllConfigs.onCall(2).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': { EXPIRATION_FEE_PER_DAY: '0.00022000' } } } }, seq: 6
            });
            await clock.tickAsync(60000);
            assert.strictEqual(indexer.lastHubConfigSeq, 6, 'advanced seq must update bookkeeping');
            assert.strictEqual(indexer.config.EXPIRATION_FEE_PER_DAY, localFee, 'consensus param must remain local across re-apply');
        } finally {
            if(indexer._hubConfigPollTimer) clearInterval(indexer._hubConfigPollTimer);
            clock.restore();
            delete process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        }
    });
});

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    // A getallconfigs call outrunning the interval must not stack
    // overlapping in-flight polls (mirrors startStateTreeMetric's guard),
    // and the guard must release in finally so one slow poll never wedges
    // all future polls.
    it('poll ticks landing while a slow poll is in flight are skipped, and polling resumes after it settles', async function () {
        indexer = makeIndexer();
        let clock = sinon.useFakeTimers();
        try {
            let inFlight = [];
            let hubStub = { configEnabled: true, getAllConfigs:sinon.stub().callsFake(() =>
                new Promise((resolve) => inFlight.push(resolve))) };
            indexer.hubClient = hubStub;

            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '60000';
            indexer.startHubConfigPolling();

            // Tick 1 starts a poll that never resolves; ticks 2 and 3 must be
            // skipped by the reentrancy guard, not stack two more calls.
            await clock.tickAsync(60000);
            await clock.tickAsync(60000);
            await clock.tickAsync(60000);
            assert.strictEqual(hubStub.getAllConfigs.callCount, 1, 'overlapping ticks must not stack polls');

            // The slow poll settles (as a failure); the guard must release and
            // the next tick polls again.
            inFlight.shift()({ error: 'slow hub finally answered' });
            await clock.tickAsync(60000);
            assert.strictEqual(hubStub.getAllConfigs.callCount, 2, 'polling must resume once the slow poll settles');
        } finally {
            if(indexer._hubConfigPollTimer) clearInterval(indexer._hubConfigPollTimer);
            clock.restore();
            delete process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        }
    });
});

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    it('poll re-applies on a watermark-only advance (standalone hub, seq stuck at 0)', async function () {
        // A standalone/config-oracle hub (no PBFT consensus) never bumps seq, but ANY
        // config write advances watermark (MAX(updated_at)). The poll must honor watermark
        // or such a hub's committed config changes are never re-applied live.
        indexer = makeIndexer();
        let clock = sinon.useFakeTimers();
        let mergeSpy = sinon.spy(indexer, 'mergeHubParams');
        try {
            let hubStub = { configEnabled: true, getAllConfigs:sinon.stub() };
            // Startup: seq 0, watermark 1000.
            hubStub.getAllConfigs.onCall(0).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 0, watermark: 1000
            });
            indexer.hubClient = hubStub;
            await indexer.applyHubConfigOverlay();
            assert.strictEqual(indexer.lastHubConfigWatermark, 1000);
            assert.strictEqual(indexer.lastHubConfigSeq, 0);
            mergeSpy.resetHistory();

            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '60000';
            indexer.startHubConfigPolling();

            // Tick 1: seq still 0, watermark equal (1000). An equal NON-ZERO watermark is
            // treated as a same-second redelivery and re-applies the idempotent merge (see
            // the dedicated redelivery test below); it is not a no-op on a watermark-bearing hub.
            hubStub.getAllConfigs.onCall(1).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 0, watermark: 1000
            });
            await clock.tickAsync(60000);
            assert.strictEqual(mergeSpy.called, true, 'equal non-zero watermark re-applies (same-second redelivery)');
            mergeSpy.resetHistory();

            // Tick 2: seq still 0, watermark advances to 2000 -> re-apply fires.
            hubStub.getAllConfigs.onCall(2).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 0, watermark: 2000
            });
            await clock.tickAsync(60000);
            assert.strictEqual(mergeSpy.called, true, 'advanced watermark must re-apply even with seq stuck at 0');
            assert.strictEqual(indexer.lastHubConfigWatermark, 2000, 'watermark bookkeeping must advance');
        } finally {
            if(indexer._hubConfigPollTimer) clearInterval(indexer._hubConfigPollTimer);
            mergeSpy.restore();
            clock.restore();
            delete process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        }
    });
});

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    // A hub restarted from an OLDER snapshot serves a lower seq AND a lower
    // watermark, which hits none of the three advance gates - and the Math.max clamp
    // keeps the stale high-water mark forever, so config re-apply stops until the hub
    // climbs back past it. The startup overlay already adopts the served values
    // unclamped; the poll was the divergent path.
    it('poll re-applies and RESETS the cursor when the hub regresses (restore from an older snapshot)', async function () {
        indexer = makeIndexer();
        let clock = sinon.useFakeTimers();
        let mergeSpy = sinon.spy(indexer, 'mergeHubParams');
        let errStub  = sinon.stub(console, 'error');
        try {
            let hubStub = { configEnabled: true, getAllConfigs:sinon.stub() };
            // Startup: seq 40, watermark 9000.
            hubStub.getAllConfigs.onCall(0).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 40, watermark: 9000
            });
            indexer.hubClient = hubStub;
            await indexer.applyHubConfigOverlay();
            assert.strictEqual(indexer.lastHubConfigSeq, 40);
            assert.strictEqual(indexer.lastHubConfigWatermark, 9000);
            mergeSpy.resetHistory();

            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '60000';
            indexer.startHubConfigPolling();

            // Tick 1: the hub comes back from an older snapshot - both cursors regress.
            hubStub.getAllConfigs.onCall(1).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 12, watermark: 3000
            });
            await clock.tickAsync(60000);
            assert.strictEqual(mergeSpy.called, true, 'a regressed hub must still re-apply its config');
            assert.strictEqual(indexer.lastHubConfigSeq, 12, 'the cursor must adopt the served seq, not clamp');
            assert.strictEqual(indexer.lastHubConfigWatermark, 3000, 'the cursor must adopt the served watermark');
            assert.ok(errStub.getCalls().some(c => /HUB CONFIG REGRESSION/.test(String(c.args[0]))),
                'a hub that lost config state is an operator event, not a silent self-heal');
            mergeSpy.resetHistory();

            // Tick 2: a normal advance past the RESET cursor re-fires; pre-fix this needed
            // the hub to climb back past the stale 40/9000 high-water mark first.
            hubStub.getAllConfigs.onCall(2).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 13, watermark: 3100
            });
            await clock.tickAsync(60000);
            assert.strictEqual(mergeSpy.called, true, 'an advance past the reset cursor must re-apply');
            assert.strictEqual(indexer.lastHubConfigSeq, 13);
            assert.strictEqual(indexer.lastHubConfigWatermark, 3100);
        } finally {
            if(indexer._hubConfigPollTimer) clearInterval(indexer._hubConfigPollTimer);
            errStub.restore();
            mergeSpy.restore();
            clock.restore();
            delete process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        }
    });
});

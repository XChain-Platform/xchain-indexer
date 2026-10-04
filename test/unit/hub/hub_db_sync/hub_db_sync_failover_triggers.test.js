'use strict';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const createHubSelector = require('../../../../src/hub/hub_db_sync/hub_selector.js');
const { makeReconnectHarness } = require('./hub_db_sync_failover_triggers.test/helpers/reconnect_harness.js');
const { makeReadyFrameHarness } = require('./hub_db_sync_failover_triggers.test/helpers/ready_frame_harness.js');
const {
    makeSelectorReadyFrameHarness
} = require('./hub_db_sync_failover_triggers.test/helpers/selector_ready_frame_harness.js');
const { makeStallHarness } = require('./hub_db_sync_failover_triggers.test/helpers/stall_harness.js');

const STALL_MS = 100;
const EXIT_MS = 200;

function twoHubSelector() {
    return createHubSelector('testnet', {
        hubSeedUrls: 'http://hub-a.test,http://hub-b.test',
        randomInt: max => max - 1
    });
}

describe('HubDbSync failover triggers', function () {
    let harness;

    afterEach(function () {
        if (harness && harness.restore) harness.restore();
        harness = null;
        sinon.restore();
    });

    it('moves after three failed reconnects and reports the move', async function () {
        const selector = twoHubSelector();
        const first = selector.current();
        const warn = sinon.stub(console, 'warn');
        harness = makeReconnectHarness({
            connectOutcomes: [new Error('one'), new Error('two'), new Error('three')],
            hubOptions: { selector }
        });

        harness.sync.scheduleReconnect();
        await harness.tickAsync(15000);

        const next = selector.current();
        const status = harness.sync.mirrorStatus();
        assert.notStrictEqual(next, first);
        assert.strictEqual(status.followedAddress, first);
        assert.strictEqual(status.lastMoveAt, 15000);
        assert.strictEqual(status.moveReason, 'connect_failure');
        assert.strictEqual(status.moveCount, 1);
        const moveLines = warn.args.map(args => args.join(' ')).filter(line => line.includes('moving hub'));
        assert.strictEqual(moveLines.length, 1);
        assert.ok(moveLines[0].includes(first));
        assert.ok(moveLines[0].includes(next));
        assert.ok(moveLines[0].includes('connect_failure'));
    });

    it('keeps the followed hub during reconnect failures inside the dwell', async function () {
        const selector = twoHubSelector();
        harness = makeReconnectHarness({
            connectOutcomes: Array.from({ length: 6 }, (_, i) => new Error('failure ' + i)),
            hubOptions: { selector, failoverMinDwellMs: 120000 }
        });

        harness.sync.scheduleReconnect();
        await harness.tickAsync(15000);
        const afterFirstMove = selector.current();
        await harness.tickAsync(15000);

        assert.strictEqual(selector.current(), afterFirstMove);
        assert.strictEqual(harness.sync.mirrorStatus().moveCount, 1);
    });

    it('moves a stalled selector after the resync stage', function () {
        const selector = twoHubSelector();
        const first = selector.current();
        harness = makeStallHarness({
            stallMs: STALL_MS,
            exitMs: EXIT_MS,
            hubOptions: { selector, failoverMinDwellMs: 0, now: () => 300 }
        });

        assert.strictEqual(harness.stage1(STALL_MS), 'resync');
        assert.strictEqual(harness.stage2(STALL_MS + EXIT_MS), 'exit');
        assert.notStrictEqual(selector.current(), first);
        assert.strictEqual(harness.resyncCalls, 2);
        assert.deepStrictEqual(harness.fatalReasons, []);
        assert.strictEqual(harness.sync.mirrorStatus().moveReason, 'stall');
    });

    it('keeps the fatal stall handler for one candidate', function () {
        harness = makeStallHarness({ stallMs: STALL_MS, exitMs: EXIT_MS });

        assert.strictEqual(harness.stage1(STALL_MS), 'resync');
        assert.strictEqual(harness.stage2(STALL_MS + EXIT_MS), 'exit');
        assert.strictEqual(harness.fatalReasons.length, 1);
    });

    it('moves from a ready hub that reports it is not caught up', async function () {
        harness = makeSelectorReadyFrameHarness({
            drainOutcomes: [{ allDrained: true, marks: [81, 89] }]
        });
        const previous = harness.selector.current();
        const advance = sinon.spy(harness.selector, 'advance');
        harness.sync._notCaughtUpSince = 1;
        harness.sync._notCaughtUpWarned = true;

        const result = await harness.deliver({ type: 'ready', watermark: 90, caught_up: false });
        await harness.sync.bootstrapAll();

        assert.strictEqual(result.certified, false);
        assert.strictEqual(harness.sync.drainEveryTable.callCount, 0);
        assert.ok(advance.calledOnceWithExactly('hub not caught up'));
        assert.notStrictEqual(result.followed, previous);
        assert.deepStrictEqual(harness.moves, [{
            next: result.followed,
            previous,
            reason: 'hub not caught up'
        }]);
        assert.strictEqual(harness.sync.mirrorStatus().moveReason, 'hub not caught up');
        assert.strictEqual(harness.sync._notCaughtUpSince, null);
        assert.strictEqual(harness.sync._notCaughtUpWarned, false);
    });

    it('drains one not-caught-up candidate after its grace and warns once', async function () {
        harness = makeSelectorReadyFrameHarness({
            seeds: ['http://hub-a.test'],
            drainOutcomes: [{ allDrained: true, marks: [81, 89] }]
        });
        harness.sync._notCaughtUpGraceMs = 0;
        const followed = harness.selector.current();
        const advance = sinon.spy(harness.selector, 'advance');
        const warn = sinon.stub(console, 'warn');

        const result = await harness.deliver({ type: 'ready', watermark: 90, caught_up: false });
        assert.strictEqual(harness.sync.certifyFullDrain([90], harness.sync._wsEpoch), true);

        assert.deepStrictEqual(result, { certified: true, followed });
        assert.strictEqual(harness.sync.drainEveryTable.callCount, 1);
        assert.strictEqual(harness.retryCalls, 0);
        assert.strictEqual(advance.callCount, 0);
        assert.deepStrictEqual(harness.moves, []);
        assert.strictEqual(warn.args.filter(args => args.join(' ') ===
            'HubDbSync: serving from the only hub although it reports not caught up').length, 1);
    });

    it('waits on one not-caught-up candidate and accepts a later caught-up frame', async function () {
        harness = makeSelectorReadyFrameHarness({
            seeds: ['http://hub-a.test'],
            drainOutcomes: [{ allDrained: true, marks: [81, 89] }]
        });
        const followed = harness.selector.current();
        const advance = sinon.spy(harness.selector, 'advance');

        const waiting = await harness.deliver({ type: 'ready', watermark: 90, caught_up: false });
        assert.notStrictEqual(harness.sync._notCaughtUpSince, null);
        assert.strictEqual(harness.sync.certifyFullDrain([90], harness.sync._wsEpoch), false);
        await harness.sync.bootstrapAll();
        const caughtUp = await harness.deliver({ type: 'ready', watermark: 90, caught_up: true });

        assert.deepStrictEqual(waiting, { certified: false, followed });
        assert.deepStrictEqual(caughtUp, { certified: true, followed });
        assert.strictEqual(harness.sync.drainEveryTable.callCount, 1);
        assert.strictEqual(harness.retryCalls, 1);
        assert.strictEqual(advance.callCount, 0);
        assert.deepStrictEqual(harness.moves, []);
        assert.strictEqual(harness.sync._notCaughtUpSince, null);
    });

    it('keeps the not-caught-up grace start across a socket close', function () {
        const sync = new HubDbSync({ doQuery: async () => [] }, { hubUrl: 'http://hub-a.test' });
        sync._notCaughtUpSince = 123;
        sync._readyCaughtUp = false;

        sync.resetOnSocketClose();

        assert.strictEqual(sync._notCaughtUpSince, 123);
        assert.strictEqual(sync._readyCaughtUp, null);
    });

    it('treats an older ready frame without caught_up as caught up', async function () {
        harness = makeReadyFrameHarness({
            drainOutcomes: [{ allDrained: true, marks: [81, 89] }]
        });

        const result = await harness.deliver({ type: 'ready', watermark: 90 });

        assert.deepStrictEqual(result, { certified: true });
        assert.strictEqual(harness.retryCalls, 0);
    });

    it('keeps new-hub data and heartbeat evidence behind the first certified drain', async function () {
        const selector = twoHubSelector();
        const sync = new HubDbSync({ doQuery: async () => [] }, {
            selector,
            failoverReconnectAttempts: 1,
            failoverMinDwellMs: 0,
            now: () => 10
        });
        sync._bootstrapDrained = true;
        sync.priceBootstrapped = true;
        sync.streamWatermark = 20;
        sync.priceSyncMaxTimestamp = 30;
        sync.oracleSyncTimestamp = 40;

        assert.strictEqual(sync.noteConnectFailure(), true);
        assert.strictEqual(sync._bootstrapDrained, false);
        assert.strictEqual(sync.priceSyncMaxTimestamp, 0);
        assert.strictEqual(sync.oracleSyncTimestamp, null);

        const applyRow = sinon.stub(sync, 'applyRow').resolves();
        const refreshOracle = sinon.stub(sync, 'refreshOracleSyncTimestamp').resolves();
        await sync.handleRowEvent({
            type: 'row:inserted',
            table: 'oracle_prices',
            row: { id: 1, effective_at: 1000 }
        });
        assert.strictEqual(applyRow.callCount, 1);
        assert.strictEqual(refreshOracle.callCount, 0);

        sync.noteHubTip(1000);
        sync.handleWatermarkFrame({ ts: 1000, heights: { price_snapshots: { BTC: 500 } } });
        assert.strictEqual(sync.streamWatermark, 20);
        assert.deepStrictEqual(sync.heightWatermarks, {});
        assert.strictEqual(sync.priceTimeSyncSatisfied(100), false);

        assert.strictEqual(sync.certifyFullDrain([1000], sync._wsEpoch), true);
        assert.strictEqual(sync._failoverPendingDrain, false);
    });

    it('refreshes local barrier positions before bootstrapping after reconnect', async function () {
        harness = makeReconnectHarness({ connectOutcomes: [undefined] });
        harness.sync.scheduleReconnect();

        await harness.tickAsync(5000);

        assert.strictEqual(harness.refreshCalls.callCount, 1);
        assert.strictEqual(harness.bootstrapCalls.callCount, 1);
        assert.ok(harness.refreshCalls.calledBefore(harness.bootstrapCalls));
    });

    it('reads reconnect and dwell settings through the hub sync environment reader', function () {
        const previousAttempts = process.env.HUB_FAILOVER_RECONNECT_ATTEMPTS;
        const previousDwell = process.env.HUB_FAILOVER_MIN_DWELL_MS;
        process.env.HUB_FAILOVER_RECONNECT_ATTEMPTS = '2';
        process.env.HUB_FAILOVER_MIN_DWELL_MS = '0';
        try {
            const selector = twoHubSelector();
            const sync = new HubDbSync({ doQuery: async () => [] }, { selector, now: () => 1 });

            assert.strictEqual(sync.noteConnectFailure(), false);
            assert.strictEqual(sync.noteConnectFailure(), true);
            assert.strictEqual(sync.mirrorStatus().moveCount, 1);
        } finally {
            if (previousAttempts === undefined) delete process.env.HUB_FAILOVER_RECONNECT_ATTEMPTS;
            else process.env.HUB_FAILOVER_RECONNECT_ATTEMPTS = previousAttempts;
            if (previousDwell === undefined) delete process.env.HUB_FAILOVER_MIN_DWELL_MS;
            else process.env.HUB_FAILOVER_MIN_DWELL_MS = previousDwell;
        }
    });

    it('reads the not-caught-up grace through the hub sync environment reader', function () {
        const previousGrace = process.env.HUB_NOT_CAUGHT_UP_GRACE_MS;
        process.env.HUB_NOT_CAUGHT_UP_GRACE_MS = '1234';
        try {
            const sync = new HubDbSync({ doQuery: async () => [] }, { hubUrl: 'http://hub-a.test' });

            assert.strictEqual(sync._notCaughtUpGraceMs, 1234);
            assert.strictEqual(new HubDbSync({}, {
                hubUrl: 'http://hub-a.test', notCaughtUpGraceMs: 0
            })._notCaughtUpGraceMs, 0);
            assert.strictEqual(new HubDbSync({}, {
                hubUrl: 'http://hub-a.test', notCaughtUpGraceMs: -1
            })._notCaughtUpGraceMs, 30000);
            assert.strictEqual(new HubDbSync({}, {
                hubUrl: 'http://hub-a.test', notCaughtUpGraceMs: Infinity
            })._notCaughtUpGraceMs, 30000);
        } finally {
            if (previousGrace === undefined) delete process.env.HUB_NOT_CAUGHT_UP_GRACE_MS;
            else process.env.HUB_NOT_CAUGHT_UP_GRACE_MS = previousGrace;
        }
    });
});

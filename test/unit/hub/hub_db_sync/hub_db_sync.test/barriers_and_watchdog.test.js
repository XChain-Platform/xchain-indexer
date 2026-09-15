// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

// Build a HubDbSync whose enabled flag is true (needs both a hub URL and a hub DB),
// backed by a stubbed doQuery we drive per-test to simulate the local price mirror.
function makeSync(maxReferenceBlock) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

// Time-keyed price barrier. It runs on every chain and is NOT conditioned on the
// NATIVE_FEE_PRICE_TIME_GATE flag-day, which covers only the fee-query half of that work.
// Non-reference chains' heights are not comparable to the rounds' BTC
// reference_block anchor, so catch-up is judged by the rounds' consensus
// timestamps (mirror MAX(block_timestamp)) or the hub stream watermark.
describe('HubDbSync time-keyed price barrier (H-3) @regression @tier3', function () {
    function makeTimeSync(maxReferenceBlock, maxTimestamp) {
        const doQuery = sinon.stub();
        doQuery.callsFake(async () => [{ h: maxReferenceBlock, ts: maxTimestamp }]);
        const hubDb = { doQuery };
        const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
        return { sync, hubDb, doQuery };
    }

    it('_refreshPriceSyncHeight adopts MAX(block_timestamp) alongside the height', async function () {
        const { sync } = makeTimeSync(123, 5000);
        await sync._refreshPriceSyncHeight();
        assert.strictEqual(sync.priceSyncHeight, 123);
        assert.strictEqual(sync.priceSyncMaxTimestamp, 5000);
    });

    it('resolves immediately when the mirror already holds a round at/past the block time', async function () {
        const { sync } = makeTimeSync(123, 5000);
        await sync._refreshPriceSyncHeight();
        const got = await sync.waitForPriceSyncTime(4000, 1000);
        assert.strictEqual(got, 5000);
    });

    it('resolves once a later sync raises the mirror max timestamp', async function () {
        const { sync, doQuery } = makeTimeSync(0, 0);
        await sync._refreshPriceSyncHeight();
        const pending = sync.waitForPriceSyncTime(4000, 2000);
        doQuery.callsFake(async () => [{ h: 10, ts: 4500 }]);
        await sync._refreshPriceSyncHeight();
        const got = await pending;
        assert.strictEqual(got, 4500);
    });

    it('resolves via the stream watermark when the hub has covered blockTime + grace', async function () {
        const { sync } = makeTimeSync(0, 0);
        await sync._refreshPriceSyncHeight();
        const pending = sync.waitForPriceSyncTime(4000, 2000);
        sync.advanceWatermark(4000 + sync.priceWatermarkGraceS);
        const got = await pending;
        assert.strictEqual(got, 0, 'watermark satisfaction does not require any local round');
    });

    it('rejects on timeout while the mirror and watermark stay behind', async function () {
        const { sync } = makeTimeSync(0, 0);
        await sync._refreshPriceSyncHeight();
        await assert.rejects(
            sync.waitForPriceSyncTime(4000, 50),
            /price time-sync barrier timed out/
        );
    });

    it('self-heals on timeout when the DB caught up but the in-memory timestamp was stale', async function () {
        const { sync, doQuery } = makeTimeSync(0, 0);
        await sync._refreshPriceSyncHeight();
        doQuery.callsFake(async () => [{ h: 10, ts: 9000 }]);   // DB is current; memory is stale
        const got = await sync.waitForPriceSyncTime(4000, 50);
        assert.strictEqual(got, 9000, 'timeout path must re-read the mirror before rejecting');
    });
});

describe('HubDbSync time-keyed price barrier (H-3) @regression @tier3', function () {
    it('is a no-op when sync is disabled (single-host)', async function () {
        const sync = new HubDbSync(null, {});
        const got = await sync.waitForPriceSyncTime(999999, 10);
        assert.strictEqual(got, 0);
    });
});

function makeWatchdogSync() {
    const doQuery = sinon.stub().resolves([{ h: 0 }]);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', watermarkIntervalMs: 10000 });
    return sync;
}

function stubWs() {
    return { terminate: sinon.stub() };
}

// Heartbeat-timeout watchdog: a reconnect that triggers
// ONLY on the socket's 'close'/'error' events lets a half-open TCP connection (no
// frames, no close/error) freeze the mirror indefinitely. The watchdog measures
// time-since-last-watermark and terminates a stalled socket so the existing
// close-handler reconnect path self-heals.
describe('HubDbSync heartbeat-timeout watchdog @regression @tier2', function () {
    it('terminates the socket once no watermark frame arrives for 3x the interval', function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            const ws = stubWs();
            sync.startWatchdog(ws);

            clock.tick(29999);
            assert.strictEqual(ws.terminate.called, false, 'must not terminate before the 3x threshold');

            clock.tick(2);
            assert.strictEqual(ws.terminate.called, true, 'must terminate once idle >= 3x the watermark interval');
        } finally {
            clock.restore();
        }
    });

    it('never fires while watermark frames keep arriving on schedule', function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            const ws = stubWs();
            sync.startWatchdog(ws);

            // Simulate a heartbeat landing every 10s, well inside the 30s timeout,
            // for several times longer than the timeout would otherwise allow.
            for (let i = 0; i < 10; i++) {
                clock.tick(10000);
                sync._lastHeartbeatAt = Date.now();
            }
            assert.strictEqual(ws.terminate.called, false, 'watchdog must not fire while heartbeats stay current');
        } finally {
            clock.restore();
        }
    });

    it('a real watermark message stamps _lastHeartbeatAt and keeps the watchdog quiet', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            sync._bootstrapDrained = true;
            const ws = stubWs();
            sync.startWatchdog(ws);

            // Advance close to (but under) the threshold, then simulate what the
            // 'watermark' message handler does: stamp liveness and advance the
            // stream watermark. The watchdog must see the reset and stay quiet
            // through another full interval.
            clock.tick(25000);
            sync._lastHeartbeatAt = Date.now();
            sync.advanceWatermark(1);
            clock.tick(25000);
            assert.strictEqual(ws.terminate.called, false, 'a fresh heartbeat must reset the idle clock');
        } finally {
            clock.restore();
        }
    });
});

describe('HubDbSync heartbeat-timeout watchdog @regression @tier2', function () {
    it('no timer remains active after _stopWatchdog (close-path cleanup)', function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            const ws = stubWs();
            sync.startWatchdog(ws);
            assert.ok(sync._watchdogTimer, 'watchdog timer set while socket is open');

            sync.stopWatchdog();
            assert.strictEqual(sync._watchdogTimer, null, 'timer reference cleared');

            clock.tick(60000);
            assert.strictEqual(ws.terminate.called, false, 'a stopped watchdog must never terminate a closed socket');
        } finally {
            clock.restore();
        }
    });

    it('starting a fresh watchdog on reconnect clears any prior timer instead of leaking it', function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            const ws1 = stubWs();
            sync.startWatchdog(ws1);
            const firstTimer = sync._watchdogTimer;

            const ws2 = stubWs();
            sync.startWatchdog(ws2);
            assert.notStrictEqual(sync._watchdogTimer, firstTimer, 'a new timer replaces the old one');

            clock.tick(30000);
            assert.strictEqual(ws1.terminate.called, false, 'the abandoned first socket must not be terminated by a leaked timer');
        } finally {
            clock.restore();
        }
    });

    it('adopts the hub-advertised watermark interval and resizes the timeout to 3x', function () {
        const sync = makeWatchdogSync();
        assert.strictEqual(sync.watermarkTimeoutMs, 30000, 'seed timeout is 3x the env/option interval');
        const adopted = sync.adoptHubWatermarkInterval(45000);
        assert.strictEqual(adopted, true, 'a valid interval is adopted');
        assert.strictEqual(sync.watermarkIntervalMs, 45000);
        assert.strictEqual(sync.watermarkTimeoutMs, 135000, 'timeout self-sizes to 3x the hub cadence');
    });

    it('ignores a missing/invalid advertised interval, keeping the env-seeded timeout (older hub)', function () {
        const sync = makeWatchdogSync();
        for (const bad of [undefined, null, 0, -1, 'x', NaN]) {
            assert.strictEqual(sync.adoptHubWatermarkInterval(bad), false, 'invalid interval is not adopted');
        }
        assert.strictEqual(sync.watermarkIntervalMs, 10000, 'interval unchanged');
        assert.strictEqual(sync.watermarkTimeoutMs, 30000, 'timeout unchanged (env-seeded fallback intact)');
    });
});

describe('HubDbSync heartbeat-timeout watchdog @regression @tier2', function () {
    it('a socket heartbeating at the hub cadence survives once the interval is adopted (drift no longer kills healthy sockets)', function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            // Hub raised its interval to 45s; without adoption the 30s (3x10s) timeout
            // would terminate a socket that legitimately heartbeats every 45s.
            sync.adoptHubWatermarkInterval(45000);
            const ws = stubWs();
            sync.startWatchdog(ws);

            for (let i = 0; i < 6; i++) {
                clock.tick(45000);
                sync._lastHeartbeatAt = Date.now();
            }
            assert.strictEqual(ws.terminate.called, false, 'a 45s-cadence socket must not be terminated after adopting the hub interval');
        } finally {
            clock.restore();
        }
    });
});

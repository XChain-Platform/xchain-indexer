// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const path   = require('path');
const sinon  = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

const POLL_MS        = 1000;
const LIFECYCLE_PATH = path.resolve(__dirname, '../../../../../src/hub/hub_db_sync/lifecycle.js');
const TRANSPORT_PATH = path.resolve(__dirname, '../../../../../src/hub/hub_db_sync/transport.js');

// Build a running mirror on one hub with a fixed poll interval.
function runningSync() {
    const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, {
        hubUrl: 'http://hub-a.test',
        pollInterval: POLL_MS
    });
    sync.running = true;
    return sync;
}

// Load the lifecycle methods against a transport whose WebSocket is `ws` (null selects poll mode).
function lifecycleWith(ws) {
    const transportEntry = require.cache[TRANSPORT_PATH];
    const lifecycleEntry = require.cache[LIFECYCLE_PATH];
    const original = transportEntry.exports;
    transportEntry.exports = Object.assign({}, original, { WebSocket: ws });
    delete require.cache[LIFECYCLE_PATH];
    try {
        return require(LIFECYCLE_PATH);
    } finally {
        transportEntry.exports = original;
        require.cache[LIFECYCLE_PATH] = lifecycleEntry;
    }
}

// A mirror whose start() reaches the first bootstrap with every side effect stubbed.
function startableSync() {
    const sync = runningSync();
    sync.running = false;
    sync.enabled = true;
    sinon.stub(sync, 'assertAutoIncrementMirrorIds').resolves();
    sinon.stub(sync, 'startStallDetector');
    sinon.stub(sync, 'connectWebSocket').resolves();
    sinon.stub(sync, 'captureConnectionAddress');
    return sync;
}

describe('HubDbSync poll timer lifecycle', function () {
    let clock;

    afterEach(function () {
        if (clock) clock.restore();
        clock = null;
        sinon.restore();
    });

    it('stop() cancels a pending poll', async function () {
        clock = sinon.useFakeTimers();
        const sync = runningSync();
        const bootstrap = sinon.stub(sync, 'bootstrapAll').resolves();
        sync.startPolling();
        sync.stop();
        await clock.tickAsync(POLL_MS * 5);
        assert.strictEqual(bootstrap.callCount, 0);
    });

    it('a stop and restart before the poll fires keeps one poll cadence', async function () {
        clock = sinon.useFakeTimers();
        const sync = runningSync();
        const bootstrap = sinon.stub(sync, 'bootstrapAll').resolves();
        sync.startPolling();
        sync.stop();
        sync.running = true;
        sync.startPolling();
        await clock.tickAsync(POLL_MS * 3);
        assert.strictEqual(bootstrap.callCount, 3);
    });

    it('a second startPolling() call does not start a second chain', async function () {
        clock = sinon.useFakeTimers();
        const sync = runningSync();
        const bootstrap = sinon.stub(sync, 'bootstrapAll').resolves();
        sync.startPolling();
        sync.startPolling();
        await clock.tickAsync(POLL_MS * 3);
        assert.strictEqual(bootstrap.callCount, 3);
    });

    it('a restart while a poll awaits bootstrapAll retires the old chain', async function () {
        clock = sinon.useFakeTimers();
        const sync = runningSync();
        let release;
        const bootstrap = sinon.stub(sync, 'bootstrapAll');
        bootstrap.onFirstCall().returns(new Promise(resolve => { release = resolve; }));
        bootstrap.resolves();
        sync.startPolling();
        await clock.tickAsync(POLL_MS);
        assert.strictEqual(bootstrap.callCount, 1);
        sync.stop();
        sync.running = true;
        sync.startPolling();
        release();
        await clock.tickAsync(POLL_MS * 3);
        assert.strictEqual(bootstrap.callCount, 4);
    });
});

describe('HubDbSync bootstrap retry timer lifecycle', function () {
    let clock;

    afterEach(function () {
        if (clock) clock.restore();
        clock = null;
        sinon.restore();
    });

    it('collapses repeat retries to one pending retry', async function () {
        clock = sinon.useFakeTimers();
        const sync = runningSync();
        const bootstrap = sinon.stub(sync, 'bootstrapAll').resolves();
        sync.scheduleBootstrapRetry(['oracle_prices']);
        const pending = sync._bootstrapRetryTimer;
        sync.scheduleBootstrapRetry(['price_snapshots']);
        assert.strictEqual(sync._bootstrapRetryTimer, pending);
        await clock.tickAsync(POLL_MS * 3);
        assert.strictEqual(bootstrap.callCount, 1);
    });

    it('stop() cancels a pending bootstrap retry', async function () {
        clock = sinon.useFakeTimers();
        const sync = runningSync();
        const bootstrap = sinon.stub(sync, 'bootstrapAll').resolves();
        sync.scheduleBootstrapRetry(['oracle_prices']);
        sync.stop();
        sync.running = true;
        await clock.tickAsync(POLL_MS * 3);
        assert.strictEqual(bootstrap.callCount, 0);
    });

    it('a deduped retry that fires and rejects arms exactly one new retry', async function () {
        clock = sinon.useFakeTimers();
        const sync = runningSync();
        const bootstrap = sinon.stub(sync, 'bootstrapAll');
        bootstrap.onFirstCall().rejects(new Error('certify threw'));
        bootstrap.resolves();
        sync.scheduleBootstrapRetry();
        sync.scheduleBootstrapRetry();
        await clock.tickAsync(POLL_MS);
        assert.strictEqual(bootstrap.callCount, 1);
        await clock.tickAsync(POLL_MS * 4);
        assert.strictEqual(bootstrap.callCount, 2);
    });
});

describe('HubDbSync start() survives a throw from its first bootstrap', function () {

    afterEach(() => sinon.restore());

    it('in WS mode resolves and arms the bootstrap retry', async function () {
        const lifecycle = lifecycleWith(function FakeWebSocket() {});
        const sync = startableSync();
        sinon.stub(sync, 'bootstrapAll').rejects(new Error('certify threw'));
        const retry = sinon.stub(sync, 'scheduleBootstrapRetry');
        const poll = sinon.stub(sync, 'startPolling');
        await lifecycle.start.call(sync);
        assert.strictEqual(retry.callCount, 1);
        assert.strictEqual(poll.callCount, 0);
    });

    it('in poll mode resolves and still starts the poll loop', async function () {
        const lifecycle = lifecycleWith(null);
        const sync = startableSync();
        sinon.stub(sync, 'bootstrapAll').rejects(new Error('certify threw'));
        const retry = sinon.stub(sync, 'scheduleBootstrapRetry');
        const poll = sinon.stub(sync, 'startPolling');
        await lifecycle.start.call(sync);
        assert.strictEqual(poll.callCount, 1);
        assert.strictEqual(retry.callCount, 0);
    });

    it('still rejects when the mirror id check refuses startup', async function () {
        const lifecycle = lifecycleWith(null);
        const sync = startableSync();
        sync.assertAutoIncrementMirrorIds.rejects(new Error('mirror startup refused'));
        const bootstrap = sinon.stub(sync, 'bootstrapAll').resolves();
        await assert.rejects(() => lifecycle.start.call(sync), /mirror startup refused/);
        assert.strictEqual(bootstrap.callCount, 0);
    });
});

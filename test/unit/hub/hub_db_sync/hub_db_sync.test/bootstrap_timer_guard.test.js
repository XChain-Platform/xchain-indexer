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
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

const POLL_MS = 1000;

// Build a running mirror on one hub with a fixed retry interval.
function runningSync() {
    const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, {
        hubUrl: 'http://hub-a.test',
        pollInterval: POLL_MS
    });
    sync.running = true;
    return sync;
}

// Count unhandled rejections for one case; Node emits them after the microtask queue drains.
function watchUnhandled() {
    const seen = [];
    const onRejection = err => seen.push(err);
    process.on('unhandledRejection', onRejection);
    return { seen, stop: () => process.removeListener('unhandledRejection', onRejection) };
}

describe('HubDbSync bootstrap timer guards', function () {
    let clock;
    let watch;

    afterEach(function () {
        if (clock) clock.restore();
        clock = null;
        if (watch) watch.stop();
        watch = null;
        sinon.restore();
    });

    it('re-arms the bootstrap retry when bootstrapAll rejects after a reconnect', async function () {
        clock = sinon.useFakeTimers();
        watch = watchUnhandled();
        const sync = runningSync();
        sinon.stub(sync, 'connectWebSocket').resolves();
        sinon.stub(sync, 'refreshAllSyncHeights').resolves();
        sinon.stub(sync, 'bootstrapAll').rejects(new Error('certify threw'));
        const retry = sinon.stub(sync, 'scheduleBootstrapRetry');

        sync.scheduleReconnect();
        await clock.tickAsync(5000);
        clock.restore();
        clock = null;
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(retry.callCount, 1);
        assert.strictEqual(watch.seen.length, 0, 'the rejection escaped the reconnect timer');
    });

    it('re-arms the bootstrap retry when the height refresh rejects after a reconnect', async function () {
        clock = sinon.useFakeTimers();
        const sync = runningSync();
        sinon.stub(sync, 'connectWebSocket').resolves();
        sinon.stub(sync, 'refreshAllSyncHeights').rejects(new Error('refresh threw'));
        const bootstrap = sinon.stub(sync, 'bootstrapAll').resolves();
        const retry = sinon.stub(sync, 'scheduleBootstrapRetry');

        sync.scheduleReconnect();
        await clock.tickAsync(5000);

        assert.strictEqual(bootstrap.callCount, 0);
        assert.strictEqual(retry.callCount, 1);
    });

    it('keeps the retry chain alive across one rejected retry without multiplying timers', async function () {
        clock = sinon.useFakeTimers();
        watch = watchUnhandled();
        const sync = runningSync();
        const bootstrap = sinon.stub(sync, 'bootstrapAll');
        bootstrap.onFirstCall().rejects(new Error('certify threw'));
        bootstrap.onSecondCall().resolves();

        sync.scheduleBootstrapRetry();
        await clock.tickAsync(POLL_MS);
        assert.strictEqual(bootstrap.callCount, 1);
        await clock.tickAsync(POLL_MS);
        assert.strictEqual(bootstrap.callCount, 2, 'the rejected retry did not re-arm');
        await clock.tickAsync(POLL_MS * 3);
        assert.strictEqual(bootstrap.callCount, 2, 'a resolved retry armed another timer');

        clock.restore();
        clock = null;
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(watch.seen.length, 0, 'the rejection escaped the retry timer');
    });

    it('does not re-arm once the mirror has drained or stopped', async function () {
        clock = sinon.useFakeTimers();
        const sync = runningSync();
        const bootstrap = sinon.stub(sync, 'bootstrapAll').callsFake(async () => {
            sync._bootstrapDrained = true;
            throw new Error('noteHeights threw after certification');
        });

        sync.scheduleBootstrapRetry();
        await clock.tickAsync(POLL_MS * 4);
        assert.strictEqual(bootstrap.callCount, 1);

        const stopped = runningSync();
        const stoppedBootstrap = sinon.stub(stopped, 'bootstrapAll').callsFake(async () => {
            stopped.running = false;
            throw new Error('rejected during stop');
        });
        stopped.scheduleBootstrapRetry();
        await clock.tickAsync(POLL_MS * 4);
        assert.strictEqual(stoppedBootstrap.callCount, 1);
    });
});

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
const createHubSelector = require('../../../../../src/hub/hub_db_sync/hub_selector.js');

function twoHubSelector() {
    return createHubSelector('testnet', {
        hubSeedUrls: 'http://hub-a.test,http://hub-b.test',
        randomInt: max => max - 1
    });
}

describe('HubDbSync failover reconnect delay', function () {
    let clock;

    afterEach(function () {
        if (clock) clock.restore();
        clock = null;
        sinon.restore();
    });

    it('connects to the next hub immediately after a failover move', async function () {
        clock = sinon.useFakeTimers();
        const selector = twoHubSelector();
        const first = selector.current();
        const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, {
            selector,
            failoverReconnectAttempts: 1,
            failoverMinDwellMs: 0
        });
        const attempted = [];
        sinon.stub(sync, 'connectWebSocket').callsFake(async () => {
            attempted.push(selector.current());
            if (attempted.length === 1) {
                sync.scheduleReconnect();
                throw new Error('first hub unavailable');
            }
        });
        sinon.stub(sync, 'refreshAllSyncHeights').resolves();
        sinon.stub(sync, 'bootstrapAll').resolves();
        sync.running = true;

        sync.scheduleReconnect();
        await clock.tickAsync(5000);

        assert.notStrictEqual(selector.current(), first);
        assert.deepStrictEqual(attempted, [first]);
        await clock.tickAsync(1);
        assert.deepStrictEqual(attempted, [first, selector.current()]);
        assert.strictEqual(clock.now, 5001);
    });

    it('keeps the five second delay for a same-hub reconnect', async function () {
        clock = sinon.useFakeTimers();
        const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, {
            hubUrl: 'http://hub-a.test'
        });
        const connect = sinon.stub(sync, 'connectWebSocket').resolves();
        sinon.stub(sync, 'refreshAllSyncHeights').resolves();
        sinon.stub(sync, 'bootstrapAll').resolves();
        sync.running = true;

        sync.scheduleReconnect();
        await clock.tickAsync(4999);
        assert.strictEqual(connect.callCount, 0);

        await clock.tickAsync(1);
        assert.strictEqual(connect.callCount, 1);
    });
});

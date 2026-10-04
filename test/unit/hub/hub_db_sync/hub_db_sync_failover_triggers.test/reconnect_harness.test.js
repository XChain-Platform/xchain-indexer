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

const { makeReconnectHarness } = require('./helpers/reconnect_harness.js');

describe('HubDbSync pinned reconnect harness', function () {
    let harness;

    afterEach(function () {
        if (harness) harness.restore();
        harness = null;
    });

    it('waits five seconds before the first reconnect attempt', async function () {
        harness = makeReconnectHarness({ connectOutcomes: [undefined] });
        harness.sync.scheduleReconnect();

        await harness.tickAsync(4999);
        assert.strictEqual(harness.connectCalls.callCount, 0);
        assert.strictEqual(harness.bootstrapCalls.callCount, 0);

        await harness.tickAsync(1);
        assert.strictEqual(harness.connectCalls.callCount, 1);
        assert.strictEqual(harness.bootstrapCalls.callCount, 1);
    });

    it('retries three failures five seconds apart and bootstraps once after success', async function () {
        harness = makeReconnectHarness({
            connectOutcomes: [
                new Error('connect one'),
                new Error('connect two'),
                new Error('connect three'),
                undefined
            ]
        });
        harness.sync.scheduleReconnect();

        for (let attempt = 1; attempt <= 4; attempt++) {
            await harness.tickAsync(4999);
            assert.strictEqual(harness.connectCalls.callCount, attempt - 1);
            await harness.tickAsync(1);
            assert.strictEqual(harness.connectCalls.callCount, attempt);
        }

        assert.strictEqual(harness.sync.refreshAllSyncHeights.callCount, 1);
        assert.strictEqual(harness.bootstrapCalls.callCount, 1);
    });

    it('restores the installed fake timer', function () {
        const nativeSetTimeout = setTimeout;
        harness = makeReconnectHarness({ connectOutcomes: [] });

        assert.notStrictEqual(setTimeout, nativeSetTimeout);
        harness.restore();
        harness = null;
        assert.strictEqual(setTimeout, nativeSetTimeout);
    });
});

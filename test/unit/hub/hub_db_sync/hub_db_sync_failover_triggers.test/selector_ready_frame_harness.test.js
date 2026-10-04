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

const {
    makeSelectorReadyFrameHarness
} = require('./helpers/selector_ready_frame_harness.js');

describe('HubDbSync selector ready frame harness', function () {
    let harness;

    afterEach(function () {
        if (harness) harness.restore();
        harness = null;
    });

    it('certifies a full drain without retrying or moving the selector', async function () {
        harness = makeSelectorReadyFrameHarness({
            drainOutcomes: [{ allDrained: true, marks: [81, 89] }]
        });
        const followed = harness.selector.current();

        const result = await harness.deliver({ type: 'ready', watermark: 90 });

        assert.deepStrictEqual(result, { certified: true, followed });
        assert.strictEqual(harness.retryCalls, 0);
        assert.deepStrictEqual(harness.moves, []);
    });

    it('leaves a partial drain uncertified and retries without moving the selector', async function () {
        harness = makeSelectorReadyFrameHarness({
            drainOutcomes: [{ allDrained: false, marks: [81] }]
        });
        const followed = harness.selector.current();

        const result = await harness.deliver({ type: 'ready', watermark: 90 });

        assert.deepStrictEqual(result, { certified: false, followed });
        assert.strictEqual(harness.retryCalls, 1);
        assert.deepStrictEqual(harness.moves, []);
    });

    it('reports the followed selector address and both seed candidates', function () {
        const seeds = ['http://hub-a.test', 'http://hub-b.test'];
        harness = makeSelectorReadyFrameHarness({ seeds, drainOutcomes: [] });

        const status = harness.sync.mirrorStatus();

        assert.strictEqual(status.followedAddress, harness.selector.current());
        assert.deepStrictEqual(status.candidates.slice().sort(), seeds.slice().sort());
    });

    it('records a test-side selector advance as one move', function () {
        harness = makeSelectorReadyFrameHarness({ drainOutcomes: [] });
        const previous = harness.selector.current();

        const next = harness.selector.advance('test');

        assert.deepStrictEqual(harness.moves, [{ next, previous, reason: 'test' }]);
    });

    it('restores sync methods and stops recording selector advances', function () {
        harness = makeSelectorReadyFrameHarness({ drainOutcomes: [] });
        const drainEveryTable = harness.sync.drainEveryTable.wrappedMethod;
        const scheduleBootstrapRetry = harness.sync.scheduleBootstrapRetry.wrappedMethod;

        harness.restore();
        harness.selector.advance('after restore');

        assert.strictEqual(harness.sync.drainEveryTable, drainEveryTable);
        assert.strictEqual(harness.sync.scheduleBootstrapRetry, scheduleBootstrapRetry);
        assert.deepStrictEqual(harness.moves, []);
        harness = null;
    });
});

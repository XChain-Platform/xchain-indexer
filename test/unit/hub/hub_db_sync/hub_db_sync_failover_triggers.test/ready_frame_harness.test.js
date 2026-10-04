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

const { makeReadyFrameHarness } = require('./helpers/ready_frame_harness.js');

describe('HubDbSync ready frame harness', function () {
    let harness;

    afterEach(function () {
        if (harness) harness.restore();
        harness = null;
    });

    it('certifies an older-hub ready frame after a full drain without retrying', async function () {
        harness = makeReadyFrameHarness({
            drainOutcomes: [{ allDrained: true, marks: [81, 89] }]
        });

        const result = await harness.deliver({ type: 'ready', watermark: 90 });

        assert.deepStrictEqual(result, { certified: true });
        assert.strictEqual(harness.sync.streamWatermark, 81);
        assert.strictEqual(harness.retryCalls, 0);
    });

    it('leaves an older-hub ready frame uncertified after a partial drain and retries once', async function () {
        harness = makeReadyFrameHarness({
            drainOutcomes: [{ allDrained: false, marks: [81] }]
        });

        const result = await harness.deliver({ type: 'ready', watermark: 90 });

        assert.deepStrictEqual(result, { certified: false });
        assert.strictEqual(harness.sync.streamWatermark, 0);
        assert.strictEqual(harness.retryCalls, 1);
    });

    it('restores every stubbed sync method', function () {
        harness = makeReadyFrameHarness({ drainOutcomes: [] });
        const drainEveryTable = harness.sync.drainEveryTable.wrappedMethod;
        const scheduleBootstrapRetry = harness.sync.scheduleBootstrapRetry.wrappedMethod;

        harness.restore();

        assert.strictEqual(harness.sync.drainEveryTable, drainEveryTable);
        assert.strictEqual(harness.sync.scheduleBootstrapRetry, scheduleBootstrapRetry);
        harness = null;
    });
});

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

const { makeStallHarness } = require('./helpers/stall_harness.js');

const STALL_MS = 100;
const EXIT_MS = 200;

describe('HubDbSync stall harness', function () {
    it('leaves an advancing stream watermark healthy', function () {
        const harness = makeStallHarness({ stallMs: STALL_MS, exitMs: EXIT_MS });
        const nextWatermark = harness.sync._hubTipTs + 1;
        harness.sync.noteHubTip(nextWatermark);
        harness.sync.advanceWatermark(nextWatermark);

        assert.strictEqual(harness.sync.checkWatermarkStall(Date.now() + STALL_MS), 'ok');
        assert.strictEqual(harness.resyncCalls, 0);
        assert.deepStrictEqual(harness.fatalReasons, []);
    });

    it('drives one resync at stage 1 without reporting a fatal stall', function () {
        const harness = makeStallHarness({ stallMs: STALL_MS, exitMs: EXIT_MS });

        assert.strictEqual(harness.stage1(STALL_MS), 'resync');
        assert.strictEqual(harness.resyncCalls, 1);
        assert.deepStrictEqual(harness.fatalReasons, []);
    });

    it('reports the frozen stream watermark once at stage 2', function () {
        const harness = makeStallHarness({ stallMs: STALL_MS, exitMs: EXIT_MS });
        const frozenWatermark = harness.sync.streamWatermark;

        assert.strictEqual(harness.stage1(STALL_MS), 'resync');
        assert.strictEqual(harness.stage2(STALL_MS + EXIT_MS), 'exit');
        assert.strictEqual(harness.fatalReasons.length, 1);
        assert.match(harness.fatalReasons[0], /stream watermark stalled/);
        assert.ok(harness.fatalReasons[0].includes(String(frozenWatermark)));
    });
});

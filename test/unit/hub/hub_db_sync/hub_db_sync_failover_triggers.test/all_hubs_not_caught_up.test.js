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
const failover = require('../../../../../src/hub/hub_db_sync/failover/triggers.js');

function seedUrls(count) {
    return Array.from({ length: count }, (_, i) => 'http://hub-' + i + '.test');
}

describe('HubDbSync failover when no candidate is caught up', function () {
    let harness;

    afterEach(function () {
        if (harness) harness.restore();
        harness = null;
    });

    function deliverNotCaughtUp() {
        harness.sync.adoptReadyFrame({}, { type: 'ready', watermark: 1, caught_up: false });
        return failover.rejectUncaughtUpReadyFrame(harness.sync);
    }

    it('stops moving once every candidate reported not caught up', function () {
        harness = makeSelectorReadyFrameHarness({ seeds: seedUrls(5), drainOutcomes: [] });

        for (let i = 0; i < 10; i++) deliverNotCaughtUp();

        assert.ok(harness.moves.length <= 4, 'moves: ' + harness.moves.length);
        assert.strictEqual(failover.allCandidatesNotCaughtUp(harness.sync), true);
    });

    it('serves from the current hub after the grace when no candidate is caught up', function () {
        harness = makeSelectorReadyFrameHarness({ seeds: seedUrls(3), drainOutcomes: [] });
        harness.sync._notCaughtUpGraceMs = 1000;
        for (let i = 0; i < 3; i++) deliverNotCaughtUp();
        const now = Date.now();

        assert.strictEqual(failover.uncaughtUpBlocks(harness.sync, now), true);
        assert.strictEqual(failover.uncaughtUpBlocks(harness.sync, now + 999), true);
        assert.strictEqual(failover.uncaughtUpBlocks(harness.sync, now + 1001), false);
    });

    it('a caught-up ready frame clears the record', function () {
        harness = makeSelectorReadyFrameHarness({ seeds: seedUrls(3), drainOutcomes: [] });
        for (let i = 0; i < 3; i++) deliverNotCaughtUp();
        assert.strictEqual(failover.allCandidatesNotCaughtUp(harness.sync), true);

        harness.sync.adoptReadyFrame({}, { type: 'ready', watermark: 1, caught_up: true });
        assert.strictEqual(failover.uncaughtUpBlocks(harness.sync), false);

        assert.strictEqual(failover.allCandidatesNotCaughtUp(harness.sync), false);
        const before = harness.moves.length;
        deliverNotCaughtUp();
        assert.strictEqual(harness.moves.length, before + 1);
    });

    it('still moves off a not-caught-up hub while a candidate is untried', function () {
        harness = makeSelectorReadyFrameHarness({ seeds: seedUrls(3), drainOutcomes: [] });
        const first = harness.selector.current();

        deliverNotCaughtUp();

        assert.strictEqual(harness.moves.length, 1);
        assert.notStrictEqual(harness.selector.current(), first);
        assert.strictEqual(failover.allCandidatesNotCaughtUp(harness.sync), false);
    });
});

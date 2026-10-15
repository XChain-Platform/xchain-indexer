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

const sinon = require('sinon');

const HubDbSync = require('../../../../../../src/hub/hub_db_sync.js');

function makeReadyFrameHarness({ drainOutcomes }) {
    const outcomes = drainOutcomes.slice();
    const hubDb = { doQuery: sinon.stub().resolves([]) };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub-a.test' });

    sync.running = true;

    const drainEveryTable = sinon.stub(sync, 'drainEveryTable').callsFake(async () => {
        if (outcomes.length === 0) throw new Error('No scripted drain outcome remains');
        const outcome = outcomes.shift();
        // A scripted complete drain stands for every table paged in full, which is what
        // settles the re-page each ready frame owes.
        if (outcome && outcome.allDrained) sync._repageOwed.clear();
        return outcome;
    });
    const scheduleBootstrapRetry = sinon.stub(sync, 'scheduleBootstrapRetry');
    const socket = {};
    let restored = false;

    const result = {
        sync,
        async deliver(frame) {
            sync.adoptReadyFrame(socket, frame);
            await sync.bootstrapAll();
            return { certified: sync._bootstrapDrained };
        },
        restore() {
            if (restored) return;
            restored = true;
            sync.running = false;
            drainEveryTable.restore();
            scheduleBootstrapRetry.restore();
        }
    };
    Object.defineProperty(result, 'retryCalls', {
        enumerable: true,
        get: () => scheduleBootstrapRetry.callCount
    });
    return result;
}

module.exports = { makeReadyFrameHarness };

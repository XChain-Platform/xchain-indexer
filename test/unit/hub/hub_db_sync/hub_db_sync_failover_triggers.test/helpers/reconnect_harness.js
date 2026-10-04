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

function makeReconnectHarness({ connectOutcomes, hubOptions = {} }) {
    const outcomes = connectOutcomes.slice();
    const hubDb = { doQuery: sinon.stub().resolves([]) };
    const clock = sinon.useFakeTimers();
    const sync = new HubDbSync(hubDb, Object.assign({ hubUrl: 'http://hub-a.test' }, hubOptions));

    sync.running = true;

    const connectCalls = sinon.stub(sync, 'connectWebSocket').callsFake(async () => {
        if (outcomes.length === 0) throw new Error('No scripted connect outcome remains');
        const outcome = outcomes.shift();
        try {
            if (outcome instanceof Error) throw outcome;
            return await outcome;
        } catch (err) {
            sync.scheduleReconnect();
            throw err;
        }
    });
    const refreshCalls = sinon.stub(sync, 'refreshAllSyncHeights').resolves();
    const bootstrapCalls = sinon.stub(sync, 'bootstrapAll').resolves();
    let restored = false;

    return {
        sync,
        clock,
        connectCalls,
        refreshCalls,
        bootstrapCalls,
        tickAsync(ms) {
            return clock.tickAsync(ms);
        },
        restore() {
            if (restored) return;
            restored = true;
            sync.running = false;
            connectCalls.restore();
            refreshCalls.restore();
            bootstrapCalls.restore();
            clock.restore();
        }
    };
}

module.exports = { makeReconnectHarness };

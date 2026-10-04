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

const STREAM_WATERMARK = 1000;

function makeStallHarness({ stallMs, exitMs, hubOptions = {} }) {
    const fatalReasons = [];
    const hubDb = { doQuery: sinon.stub().resolves([]) };
    const sync = new HubDbSync(hubDb, Object.assign({
        hubUrl: 'http://127.0.0.1',
        onFatalStall: reason => fatalReasons.push(reason)
    }, hubOptions));

    sync.running = true;
    sync._bootstrapDrained = true;
    sync.watermarkStallMs = stallMs;
    sync.watermarkStallExitMs = exitMs;
    sync.streamWatermark = STREAM_WATERMARK;
    sync._lastWatermarkAdvanceAt = 0;
    sync.noteHubTip(STREAM_WATERMARK + 1);

    const driveResync = sinon.stub(sync, 'driveResync');
    const sample = now => {
        sync.noteHubTip(sync._hubTipTs + 1);
        return sync.checkWatermarkStall(now);
    };
    const result = {
        sync,
        fatalReasons,
        stage1: sample,
        stage2: sample
    };
    Object.defineProperty(result, 'resyncCalls', {
        enumerable: true,
        get: () => driveResync.callCount
    });
    return result;
}

module.exports = { makeStallHarness };

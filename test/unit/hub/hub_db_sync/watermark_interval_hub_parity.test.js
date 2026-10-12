// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// test/unit/hub/hub_db_sync/watermark_interval_hub_parity.test.js
//
// Heartbeat-interval ceiling hub parity. The hub clamps the interval it advertises in
// the ready frame to WATERMARK_INTERVAL_MAX_MS (xchain-hub/src/peers/hub_db_broadcaster.js),
// and adoptHubWatermarkInterval clamps what it adopts to its own ceiling before dropping a
// socket idle for 3x that. A hub ceiling above the client's makes a healthy socket that
// heartbeats slower than the client ceiling time out and reconnect on a loop; a client
// ceiling above the hub's is a bound nothing reaches. So the two are pinned equal here.
// The explorer runs a byte-identical copy of the client half (sync-hub-mirror-client.sh).

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

// Transcribed from the hub so this suite grades the client without a hub checkout; the
// drift alarm below re-reads the hub source when a usable sibling checkout is present.
const HUB_WATERMARK_INTERVAL_MAX_MS = 300000;

describe('hub watermark-interval ceiling parity @regression @tier3', function () {

    it('adopts no interval above the hub advertised ceiling, and clamps exactly to it', function () {
        const sync = new HubDbSync({ doQuery: sinon.stub().resolves([{ h: 0 }]) },
                                   { hubUrl: 'http://hub.test', watermarkIntervalMs: 10000 });
        assert.strictEqual(sync.adoptHubWatermarkInterval(Number.MAX_SAFE_INTEGER), true);
        assert.strictEqual(sync.watermarkIntervalMs, HUB_WATERMARK_INTERVAL_MAX_MS,
            'the client ceiling must equal the hub ceiling; move both, and rerun ' +
            'bin/sync-hub-mirror-client.sh so the explorer copy follows');
        assert.strictEqual(sync.watermarkTimeoutMs, 3 * HUB_WATERMARK_INTERVAL_MAX_MS);
    });

    it('the hub source still declares the transcribed ceiling', function () {
        const hubSrc = path.join(__dirname, '..', '..', '..', '..', '..',
                                 'xchain-hub', 'src', 'peers', 'hub_db_broadcaster.js');
        const verdict = siblingCheckout(__dirname, hubSrc);
        if(!verdict.usable) return skipOrFail(this, verdict, 'the hub watermark-interval ceiling drift alarm');
        const text = fs.readFileSync(hubSrc, 'utf8');
        const hits = [...text.matchAll(/const WATERMARK_INTERVAL_MAX_MS = (\d+);/g)];
        assert.strictEqual(hits.length, 1, 'the hub must declare WATERMARK_INTERVAL_MAX_MS exactly once');
        assert.strictEqual(Number(hits[0][1]), HUB_WATERMARK_INTERVAL_MAX_MS,
            'the hub ceiling moved: move the client ceiling in src/hub/hub_db_sync/watermarks.js ' +
            'and HUB_WATERMARK_INTERVAL_MAX_MS here with it');
    });
});

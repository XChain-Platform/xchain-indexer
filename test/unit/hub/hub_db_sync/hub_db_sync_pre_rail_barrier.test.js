/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/hub/hub_db_sync/hub_db_sync_pre_rail_barrier.test.js
 *
 * Price sync barriers keep a block waiting while the mirror is behind. The
 * wait clears only once the mirror catches up, or times out if it never does.
 * These tests pin both paths through the public entry point.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');

const BLOCK_TS = 1756000000;

// A HubDbSync with sync enabled and an empty mirror: priceBootstrapped false,
// no max timestamp, no watermark, no height. Neither documented barrier
// escape can open from this state, so anything that resolves without one
// changing is the pre-rail escape and nothing else.
function makeSync() {
    const doQuery = sinon.stub().callsFake(async () => []);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'testnet', coin: 'BTC' });
    sync.priceBootstrapped     = false;
    sync.priceSyncHeight       = 0;
    sync.priceSyncMaxTimestamp = 0;
    sync.streamWatermark       = 0;
    // The barrier self-heals off the DB before rejecting; the fake mirror
    // answers nothing, so stub the refresh rather than assert on a no-op query.
    sinon.stub(sync, 'refreshPriceSyncHeight').resolves();
    return sync;
}

describe('HubDbSync price barrier while the mirror is behind @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('waits while the mirror is behind, and clears when the mirror catches up, not on a timeout', async function () {
        this.timeout(5000);
        const sync = makeSync();

        const heightPromise = sync.waitForPriceSyncHeight(500, 5000, BLOCK_TS);
        const timePromise   = sync.waitForPriceSyncTime(BLOCK_TS, 5000);
        assert.strictEqual(sync._priceWaiters.length, 1, 'a block behind the mirror must enter the height wait queue');
        assert.strictEqual(sync._priceTimeWaiters.length, 1, 'a block behind the mirror must enter the time wait queue');

        // The mirror catches up well inside the timeout, so both barriers
        // resolve from real mirror state rather than timing out.
        sync.priceBootstrapped     = true;
        sync.priceSyncHeight       = 500;
        sync.priceSyncMaxTimestamp = BLOCK_TS;
        sync._bootstrapDrained     = true;
        sync.releasePriceWaiters();
        sync.releasePriceTimeWaiters();

        const h  = await heightPromise;
        const ts = await timePromise;
        assert.strictEqual(h,  500);
        assert.strictEqual(ts, BLOCK_TS);
        assert.strictEqual(sync._priceWaiters.length, 0);
        assert.strictEqual(sync._priceTimeWaiters.length, 0);
    });

    it('times out when the mirror never catches up', async function () {
        this.timeout(5000);
        const sync = makeSync();

        const heightPromise = sync.waitForPriceSyncHeight(500, 30, BLOCK_TS);
        const timePromise   = sync.waitForPriceSyncTime(BLOCK_TS, 30);

        await assert.rejects(heightPromise, /price sync barrier timed out/);
        await assert.rejects(timePromise,   /price time-sync barrier timed out/);
    });
});

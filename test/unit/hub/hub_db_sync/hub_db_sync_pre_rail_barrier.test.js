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
 * D5 (ruled (a) 2026-09-22): the price sync barriers must tell "no price
 * rail existed at this height" apart from "the rail is behind". The first
 * has nothing to wait for on any node and must resolve immediately; the
 * second is a real wait that clears only once the mirror actually catches
 * up, or times out if it never does. Collapsing the two into one is what
 * made a chain-only replay of pre-batch history pay one full barrier
 * timeout on every transaction-bearing block (measured 2026-09-09, about
 * 16 minutes each).
 *
 * The floor map, the comparator and their wiring into both barriers are
 * pinned by hub_db_sync_pre_batch_era_floor.test.js. This file is the
 * row's own acceptance test and proves the DISTINCTION end to end through
 * the public entry point: a pre-rail block never enters the wait queue at
 * all, while a behind-rail block enters it and clears on real data, not
 * merely on the clock.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');

const FLOOR       = 1756000000;
const PRE_RAIL_TS = FLOOR - 86400;
const AT_FLOOR_TS = FLOOR;

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
    sync._priceEraFloorS       = FLOOR;
    // The barrier self-heals off the DB before rejecting; the fake mirror
    // answers nothing, so stub the refresh rather than assert on a no-op query.
    sinon.stub(sync, 'refreshPriceSyncHeight').resolves();
    return sync;
}

describe('HubDbSync pre-rail barrier (D5) @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('a block with no price rail at its height opens immediately, never entering the wait queue', async function () {
        this.timeout(5000);
        const sync = makeSync();
        const started = Date.now();

        const h  = await sync.waitForPriceSyncHeight(500, 600000, PRE_RAIL_TS);
        const ts = await sync.waitForPriceSyncTime(PRE_RAIL_TS, 600000);
        const elapsed = Date.now() - started;

        assert.strictEqual(h,  sync.priceSyncHeight);
        assert.strictEqual(ts, sync.priceSyncMaxTimestamp);
        assert.ok(elapsed < 1000, 'a pre-rail block must not wait at all, waited ' + elapsed + 'ms');
        assert.strictEqual(sync._priceWaiters.length, 0, 'no height waiter was ever enqueued');
        assert.strictEqual(sync._priceTimeWaiters.length, 0, 'no time waiter was ever enqueued');
    });

    it('a block where the rail is behind waits, and clears when the mirror catches up, not on a timeout', async function () {
        this.timeout(5000);
        const sync = makeSync();

        const heightPromise = sync.waitForPriceSyncHeight(500, 5000, AT_FLOOR_TS);
        const timePromise   = sync.waitForPriceSyncTime(AT_FLOOR_TS, 5000);
        assert.strictEqual(sync._priceWaiters.length, 1, 'a behind-rail block must enter the height wait queue');
        assert.strictEqual(sync._priceTimeWaiters.length, 1, 'a behind-rail block must enter the time wait queue');

        // The mirror catches up well inside the timeout. If the pre-rail and
        // behind-rail cases were not actually distinguished, this could only
        // ever resolve by timing out.
        sync.priceBootstrapped     = true;
        sync.priceSyncHeight       = 500;
        sync.priceSyncMaxTimestamp = AT_FLOOR_TS;
        sync.releasePriceWaiters();
        sync.releasePriceTimeWaiters();

        const h  = await heightPromise;
        const ts = await timePromise;
        assert.strictEqual(h,  500);
        assert.strictEqual(ts, AT_FLOOR_TS);
        assert.strictEqual(sync._priceWaiters.length, 0);
        assert.strictEqual(sync._priceTimeWaiters.length, 0);
    });

    it('a block where the rail is behind and never catches up still times out, exactly as it does with no floor armed', async function () {
        this.timeout(5000);
        const sync = makeSync();

        const heightPromise = sync.waitForPriceSyncHeight(500, 30, AT_FLOOR_TS);
        const timePromise   = sync.waitForPriceSyncTime(AT_FLOOR_TS, 30);

        await assert.rejects(heightPromise, /price sync barrier timed out/);
        await assert.rejects(timePromise,   /price time-sync barrier timed out/);
    });
});

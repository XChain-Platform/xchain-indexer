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
 * test/unit/hub_db_sync_pre_batch_era_floor.test.js
 *
 * PRE-BATCH ERA FLOOR for both price sync barriers (operator ruling
 * 2026-09-11, option b).
 *
 * The defect these tests pin was measured on testnet 2026-09-09: replaying
 * history older than the price rail pays one FULL barrier timeout per
 * transaction-bearing block, because an empty price_snapshots opens neither
 * escape (no round at or past the block time, and nothing advancing the hub
 * watermark), so a chain-only bootstrap across a pre-rail era needs weeks.
 *
 * What is asserted is BEHAVIOUR, not the constant: a block below the floor
 * comes back from the barrier immediately even with a ten-minute timeout and
 * an empty mirror, and a block at or above it still defers exactly as it does
 * today. The at/above half is what keeps this an escape for an era with no
 * rounds rather than a hole in the barrier.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');
const floorMod  = require('../../src/price_batching_floor_activation.js');

// An armed rail start and two blocks either side of it. The pre-era block is a
// day below the floor; the era block sits exactly ON it, which is the inclusive
// boundary the barrier must still police.
const FLOOR      = 1756000000;
const PRE_ERA_TS = FLOOR - 86400;
const ERA_TS     = FLOOR;

// A HubDbSync with sync ENABLED (hubUrl + hubDb) and a mirror that holds
// nothing: priceBootstrapped false, no max timestamp, no watermark. In that
// state neither documented barrier escape can ever open, so anything that
// returns is the era floor and nothing else.
function makeSync(floorS) {
    const doQuery = sinon.stub().callsFake(async () => []);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'testnet', coin: 'BTC' });
    sync.priceBootstrapped     = false;
    sync.priceSyncHeight       = 0;
    sync.priceSyncMaxTimestamp = 0;
    sync.streamWatermark       = 0;
    // The barrier self-heals off the DB before rejecting; the fake mirror answers
    // nothing, so stub the refresh out rather than assert on a no-op query.
    sinon.stub(sync, '_refreshPriceSyncHeight').resolves();
    if (floorS !== undefined) sync._priceEraFloorS = floorS;
    return sync;
}

describe('HubDbSync pre-batch era floor @regression @tier1', function () {

    afterEach(function () { sinon.restore(); });

    it('replays a pre-activation block without waiting, on BOTH barriers', async function () {
        this.timeout(5000);
        const sync = makeSync(FLOOR);

        // A ten-minute timeout: if the barrier waits at all, this test cannot pass.
        const started = Date.now();
        const ts = await sync.waitForPriceSyncTime(PRE_ERA_TS, 600000);
        const h  = await sync.waitForPriceSyncHeight(500, 600000, PRE_ERA_TS);
        const elapsed = Date.now() - started;

        assert.strictEqual(ts, sync.priceSyncMaxTimestamp);
        assert.strictEqual(h,  sync.priceSyncHeight);
        assert.ok(elapsed < 1000, 'a pre-batch-era block must not wait at all, waited ' + elapsed + 'ms');
        // No waiter enqueued means no timer was armed: the block did not "resolve
        // quickly", it never entered the barrier's queue.
        assert.strictEqual(sync._priceTimeWaiters.length, 0);
        assert.strictEqual(sync._priceWaiters.length, 0);
    });

    it('still defers a block AT the floor, and times out there as before', async function () {
        this.timeout(5000);
        const sync = makeSync(FLOOR);

        const timeP = sync.waitForPriceSyncTime(ERA_TS, 30);
        assert.strictEqual(sync._priceTimeWaiters.length, 1, 'a block at the floor must enter the barrier queue');
        await assert.rejects(timeP, /price time-sync barrier timed out/);

        const heightP = sync.waitForPriceSyncHeight(500, 30, ERA_TS);
        assert.strictEqual(sync._priceWaiters.length, 1);
        await assert.rejects(heightP, /price sync barrier timed out/);
    });

    it('does not let a pre-era block trip the bounded-mirror re-floor', async function () {
        this.timeout(5000);
        const sync = makeSync(FLOOR);
        // A bounded mirror whose floor is well above the pre-era block. Without the
        // escape, gating that block abandons the bound and re-mirrors the whole
        // table, which is part of the same replay cost.
        sync._priceMirrorFloorTs = FLOOR - 3600;

        await sync.waitForPriceSyncTime(PRE_ERA_TS, 600000);

        assert.strictEqual(sync._priceMirrorRefloor, false, 'a block that can read no round is not evidence of a short mirror');
        assert.strictEqual(sync._priceMirrorBoundDisabled, false);
        assert.strictEqual(sync._priceMirrorFloorTs, FLOOR - 3600, 'the bound must survive a pre-era block');
    });

    it('fails CLOSED without a usable block time, even with the floor armed', async function () {
        this.timeout(5000);
        const sync = makeSync(FLOOR);

        // The height barrier accepts a legacy caller with no block time at all. An
        // armed floor must not read a missing time as "the oldest possible block":
        // it defers, which is the deployed behaviour.
        const p = sync.waitForPriceSyncHeight(500, 30);
        assert.strictEqual(sync._priceWaiters.length, 1, 'a block with no time must still defer');
        await assert.rejects(p, /price sync barrier timed out/);

        // Same for the empty-ish values Number() would happily turn into 0.
        for (const bad of [null, '', false, 0, -1, NaN]) {
            assert.strictEqual(floorMod.isPreBatchEraFloor(bad, FLOOR), false,
                'block time ' + String(bad) + ' must not open the pre-era escape');
        }
    });

    it('is inert on an unarmed network: the barrier applies to the oldest block there is', async function () {
        this.timeout(5000);
        // No floor override: the instance resolves whatever the shipped map holds for
        // testnet. Every shipped entry is 0 (no pre-batch era recognized), so even a
        // block from 1970 defers, which is the behaviour deployed today.
        const sync = makeSync();
        assert.strictEqual(sync._priceEraFloorS, 0);

        const p = sync.waitForPriceSyncTime(1, 30);
        assert.strictEqual(sync._priceTimeWaiters.length, 1);
        await assert.rejects(p, /price time-sync barrier timed out/);
    });

    it('resolves the floor per network, coin-keyed first, and 0 for anything unusable', function () {
        for (const net of ['mainnet', 'testnet', 'regtest']) {
            assert.strictEqual(floorMod.priceEraFloorS(net), 0, net + ' ships unarmed');
        }
        assert.strictEqual(floorMod.priceEraFloorS('kittennet'), 0, 'an unknown network has no era');
        assert.strictEqual(floorMod.priceEraFloorS(undefined), 0);

        // A per-chain rail start must win over the bare network key, so one chain can
        // carry a floor its siblings do not.
        const map = floorMod.PRICE_BATCHING_FLOOR_ACTIVATION;
        try {
            map.testnet    = 10;
            map['BTC:testnet'] = 99;
            assert.strictEqual(floorMod.priceEraFloorS('testnet', 'BTC'), 99);
            assert.strictEqual(floorMod.priceEraFloorS('testnet', 'DOGE'), 10);
            // Unusable values collapse to "no era" rather than to a floor nobody meant.
            map.testnet = 'soon';
            assert.strictEqual(floorMod.priceEraFloorS('testnet', 'DOGE'), 0);
            map.testnet = -5;
            assert.strictEqual(floorMod.priceEraFloorS('testnet', 'DOGE'), 0);
        } finally {
            map.testnet = 0;
            delete map['BTC:testnet'];
        }
    });

    it('puts the era boundary exactly at the floor', function () {
        assert.strictEqual(floorMod.isPreBatchEraFloor(FLOOR - 1, FLOOR), true);
        assert.strictEqual(floorMod.isPreBatchEraFloor(FLOOR, FLOOR), false, 'the floor block itself is IN the rail era');
        assert.strictEqual(floorMod.isPreBatchEraFloor(FLOOR + 1, FLOOR), false);
        // An unarmed floor recognizes no era at all.
        assert.strictEqual(floorMod.isPreBatchEraFloor(1, 0), false);
        assert.strictEqual(floorMod.isPriceBarrierRequired(1, 'testnet', 'BTC'), true);
    });
});

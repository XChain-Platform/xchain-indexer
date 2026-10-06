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
 * Unit: a price landing wait on a future-stamped block is a future-block wait
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync     = require('../../../../src/hub/hub_db_sync.js');
const priceBarriers = require('../../../../src/XChainIndexer/price_barriers.js');
const { stallClassOf, waitingOnFutureBlock, nextBarrierHold } = require('../../../../src/XChainIndexer/stall_health.js');
const { stubActiveAt } = require('../../../helpers/gate_modules.js');

const LANDED_ROW = 'price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION';
const HEIGHT = 155403;
const BLOCK_TIME = 1791310832;
const DOGE_LANDED = 1791307667;
const GRACE_MS = 120000;

function makeIndexer() {
    const sync = new HubDbSync({ doQuery: async () => [] }, { enabled: true, network: 'testnet', coin: 'TBTC' });
    sync.enabled = true;
    sync.noteLanded({ DOGE: { block: 67970000, protocol_time: DOGE_LANDED } });
    return Object.assign({ hubDbSync: sync, priceSyncTimeoutMs: 20, config: { COIN: 'TBTC' } }, priceBarriers);
}

describe('price landing future-stamped block wait @regression @tier1', function () {

    beforeEach(function () {
        stubActiveAt(sinon, LANDED_ROW, true);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('reads a landing wait on a future-stamped block as future_block_wait', async function () {
        const now = (BLOCK_TIME - 3000) * 1000;
        sinon.useFakeTimers({ now: now, toFake: ['Date'] });
        const ix = makeIndexer();
        assert.strictEqual(await ix.deferOnPriceLandingSync(HEIGHT, BLOCK_TIME, true), true);
        assert.strictEqual(ix.stallReason, 'price_sync_barrier');
        assert.strictEqual(ix.stallClearsAt, (BLOCK_TIME + 1) * 1000);
        assert.strictEqual(waitingOnFutureBlock(ix.stallReason, ix.stallClearsAt, now), true);
        assert.strictEqual(stallClassOf(ix.stallReason, now - 3600000, GRACE_MS, now, ix.stallClearsAt), 'future_block_wait');
    });

    it('takes no hold toward the ceiling while the landing wait is future-stamped', async function () {
        const now = (BLOCK_TIME - 3000) * 1000;
        sinon.useFakeTimers({ now: now, toFake: ['Date'] });
        const ix = makeIndexer();
        await ix.deferOnPriceLandingSync(HEIGHT, BLOCK_TIME, true);
        assert.strictEqual(nextBarrierHold(null, HEIGHT, ix.stallReason, ix.stallClearsAt, now), null);
    });

    it('keeps a landing wait whose time has passed without a clear instant', async function () {
        const now = (BLOCK_TIME + 600) * 1000;
        sinon.useFakeTimers({ now: now, toFake: ['Date'] });
        const ix = makeIndexer();
        assert.strictEqual(await ix.deferOnPriceLandingSync(HEIGHT, BLOCK_TIME, true), true);
        assert.strictEqual(ix.stallClearsAt, null);
        assert.strictEqual(stallClassOf(ix.stallReason, now - 3600000, GRACE_MS, now, ix.stallClearsAt), 'wedged');
    });

    it('keeps a block-unit landing shortfall without a clear instant', async function () {
        const now = (BLOCK_TIME - 3000) * 1000;
        sinon.useFakeTimers({ now: now, toFake: ['Date'] });
        const ix = makeIndexer();
        ix.hubDbSync.priceLandingShortfall = () => ({ chain: 'TBTC', have: 1, need: HEIGHT - 1, unit: 'block' });
        assert.strictEqual(await ix.deferOnPriceLandingSync(HEIGHT, BLOCK_TIME, true), true);
        assert.strictEqual(ix.stallClearsAt, null);
    });
});

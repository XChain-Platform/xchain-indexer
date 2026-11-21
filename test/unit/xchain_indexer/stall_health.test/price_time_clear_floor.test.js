/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * Unit: price time barrier health clear floor
 */

'use strict';

const assert = require('assert');

const priceBarriers = require('../../../../src/XChainIndexer/price_barriers.js');

function subject(active = false){
    return {
        hubDbSync: {},
        mirrorAdmissionActiveAt: () => active
    };
}

describe('price time barrier health clear floor @regression @tier1', function(){
    it('reports no future wait after the block timestamp has passed', function(){
        const now = 1_800_000_000_000;
        const clearsAt = priceBarriers.priceTimeClearsAt.call(
            subject(), now / 1000 - 600, 100, now);
        assert.strictEqual(clearsAt, null,
            'a past block can clear on mirrored content now and must accrue a hold');
    });

    it('reports the block timestamp while that timestamp is still in the future', function(){
        const now = 1_800_000_000_000;
        const blockTime = now / 1000 + 600;
        const clearsAt = priceBarriers.priceTimeClearsAt.call(
            subject(), blockTime, 100, now);
        assert.strictEqual(clearsAt, blockTime * 1000);
    });

    it('reports no clock floor after mirror admission activates', function(){
        const now = 1_800_000_000_000;
        const clearsAt = priceBarriers.priceTimeClearsAt.call(
            subject(true), now / 1000 + 600, 100, now);
        assert.strictEqual(clearsAt, null);
    });
});

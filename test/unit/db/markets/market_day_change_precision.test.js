'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// The 24-hour change is a display figure on the unhashed markets table. It must be
// computed from the full-precision prices, not from prices cut to 8 places first.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const Utility = require('../../../../src/utility');
const { applyDayChanges } = require('../../../../src/db/orders/market_reads.js');

const util = new Utility();

function change(now, before) {
    const data = { tick1_price: now, tick1_24hr_price: before, tick2_price: '0', tick2_24hr_price: '0' };
    applyDayChanges({ util }, data);
    return util.bcstr(data.tick1_24hr_change);
}

describe('market 24-hour change divides on full-precision prices', function () {
    it('keeps sub-8-decimal prices from collapsing the change', function () {
        // Both prices truncate to 0.00000001 at 8 places, which reported 0 change; the real change is +99.99%.
        assert.strictEqual(change('0.000000019999', '0.00000001'), '99.99');
    });

    it('does not shift a change that 8-place truncation moves', function () {
        assert.strictEqual(change('0.00000003', '0.000000019'), '57.89');
    });

    it('still reports an ordinary change and a zero baseline as 0', function () {
        assert.strictEqual(change('150', '100'), '50');
        assert.strictEqual(change('5', '0'), '0');
    });
});

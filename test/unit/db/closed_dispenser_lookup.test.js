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
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { dbWithDoQuery } = require('./db_queries.test/helpers/db_stub');
const dispenserPrices = require('../../../src/utility/price_age/dispenser_prices.js');

afterEach(function () {
    sinon.restore();
});

// The closed-dispenser lookup that tags a dropped DISPENSE trigger must recognise every
// terminal dispenser status, the same set util.isDispenserSettled guards the refund with.
const TERMINAL = ['cancelled', 'empty', 'expired', 'max_dispenses_reached'];
const LIVE = ['open', 'cancelling'];

// The status literals of the lookup's `s3.status IN (...)` filter.
function statusFilter(sql) {
    const m = /s3\.status IN \(([^)]*)\)/.exec(sql);
    assert.ok(m, 'the lookup filters on s3.status IN (...)');
    return m[1].split(',').map(s => s.trim().replace(/'/g, '')).sort();
}

describe('closed dispenser lookup covers every terminal status @regression @tier1', function () {
    it('returns a sold-out dispenser with reason empty', async function () {
        const db = dbWithDoQuery([{ action_index: 9, status: 'empty' }]);
        assert.deepStrictEqual(await db.getClosedDispenserAtAddress('BTC', 'addr'),
            { ACTION_INDEX: 9, REASON: 'empty' });
    });

    it('returns a fill-capped dispenser with reason max_dispenses_reached', async function () {
        const db = dbWithDoQuery([{ action_index: 10, status: 'max_dispenses_reached' }]);
        assert.deepStrictEqual(await db.getClosedDispenserAtAddress('BTC', 'addr'),
            { ACTION_INDEX: 10, REASON: 'max_dispenses_reached' });
    });

    it('returns false when no dispenser at the address is closed', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getClosedDispenserAtAddress('BTC', 'addr'), false);
    });

    it('filters on exactly the statuses util.isDispenserSettled treats as settled', async function () {
        const db = dbWithDoQuery([]);
        await db.getClosedDispenserAtAddress('BTC', 'addr');
        const filter = statusFilter(db.doQuery.firstCall.args[0]);
        assert.deepStrictEqual(filter, [...TERMINAL].sort());
        for (const s of filter) assert.strictEqual(dispenserPrices.isDispenserSettled(s), true, s);
        for (const s of LIVE) assert.strictEqual(dispenserPrices.isDispenserSettled(s), false, s);
    });

    it('orders by newest dispenser so the latest closed one names the reason', async function () {
        const db = dbWithDoQuery([]);
        await db.getClosedDispenserAtAddress('BTC', 'addr');
        assert.ok(/ORDER BY d1\.action_index DESC\s+LIMIT 1/.test(db.doQuery.firstCall.args[0]));
    });
});

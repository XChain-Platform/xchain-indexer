/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * dispenser_fiat_pricing_activation, the oracle tie order.
 *
 * oracle_prices is unique on (source_chain, action_index), so two chains can each publish
 * a row for one oracle at one effective_at with one action_index. Ordered only by
 * (effective_at, action_index), the tie resolves in the order the mirror received the
 * rows. Armed, source_chain is the last key, so every mirror picks the same row. Each
 * case runs the real statements on two sqlite mirrors filled in opposite orders.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../../../src/utility.js');
const { priceStore, withArming } = require('./helpers/price_store.js');

const T = 1700002400;
const B = 4;
const WINDOW = 86400;
const ORACLE = 'oracleAddress111';

// One oracle, one tick, one effective_at, one action_index, two source chains, two prices.
const FROM_LTC  = { addr: ORACLE, chain: 'LTC',  coin: 'BTC', tick: 'ZERO', fiat: 'USD', value: '1.00000000', eff: T - 1000, ai: 777 };
const FROM_DOGE = { addr: ORACLE, chain: 'DOGE', coin: 'BTC', tick: 'ZERO', fiat: 'USD', value: '4.00000000', eff: T - 1000, ai: 777 };
const ROUND     = { round: 1, pair: 'BTC/USD', price: '60000.00000000', ref: 1, ts: T - 2000 };
const FORWARD = [ROUND, FROM_LTC, FROM_DOGE];
const REVERSE = [ROUND, FROM_DOGE, FROM_LTC];

function util(){
    let u = new Utility();
    u.config['COIN'] = 'BTC';
    u.config['NETWORK'] = 'regtest';
    return u;
}

// The fill count a 0.0001 BTC payment buys at the oracle row this mirror picks.
async function settledUnits(rows){
    let m = await util().reverseOraclePriceMatch('0.00010000', ORACLE, 'BTC', 'ZERO', 'USD', T, WINDOW,
        priceStore('BTC', rows), 'BTC', B);
    return m ? m.units : 0;
}

// The oracle value a DISPENSER create at this block values its oracle fee on.
async function createTimeValue(rows){
    let dispenser = { ORACLE_ADDRESS: ORACLE, GIVE_COIN: 'BTC', GIVE_TICK: 'ZERO', FIAT_CODE: 'USD' };
    let check = await util().requireEffectiveOraclePrice(T, dispenser, priceStore('BTC', rows), B);
    return check.oracleRow.value;
}

describe('dispenser_fiat_pricing_activation: oracle tie order @regression @tier1', function () {

    it('unarmed, two mirrors filled in opposite orders settle the tie differently (the replay case)', async function () {
        await withArming(undefined, async () => {
            assert.notStrictEqual(await settledUnits(FORWARD), await settledUnits(REVERSE));
        });
    });

    it('armed, the settlement read picks the same row whatever order the mirror received', async function () {
        await withArming('armed', async () => {
            assert.strictEqual(await settledUnits(REVERSE), await settledUnits(FORWARD));
        });
    });

    it('armed, the create-time effective price picks the same row whatever order the mirror received', async function () {
        await withArming('armed', async () => {
            assert.strictEqual(await createTimeValue(REVERSE), await createTimeValue(FORWARD));
        });
    });

    it('armed, the tie goes to the greatest source_chain, as the last DESC key', async function () {
        await withArming('armed', async () => {
            assert.strictEqual(await settledUnits(REVERSE), 6, 'LTC sorts above DOGE: 6 USD buys six 1.00 USD tokens');
            assert.strictEqual(await createTimeValue(FORWARD), '1.00000000');
        });
    });
});

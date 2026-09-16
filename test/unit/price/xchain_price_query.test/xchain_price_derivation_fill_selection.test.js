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
 * test/unit/price/xchain_price_query.test/xchain_price_derivation_fill_selection.test.js
 *
 * Sibling block of the xchain_price_query.test.js suite, carrying:
 *   XCHAIN price derivation: fill selection @regression
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert  = require('assert');
const Utility = require('../../../../src/utility.js');
const { deriveXchainRate } = require('../../../../src/consensus/xchain_price.js');
const {
    VENUE_DISPENSE, VENUE_DEX, XCHAIN_TICK_SQL, COIN_ID_SQL, DISPENSE_FILLS_SQL, DEX_FILLS_SQL,
    computeWindowBounds, selectCoinId, selectXchainTickId, mapDispenseRow, mapDexRow, compareFills,
    getWindowFills,
} = require('../../../../src/consensus/xchain_price_query.js');


const BTC_COIN_ID    = 1;
const XCHAIN_TICK_ID = 1;
const GAS_TICK       = 'XCHAIN';




const DISPENSE_ROW_946 = Object.freeze({
    venue: 'dispense', action_index: 946, block_index: 2018,
    xchain_amount: '5', coin_amount: '0.01100000',
});




const DEX_ROW_185_COIN_GIVE = Object.freeze({
    venue: 'dex', action_index: 185, block_index: 782,
    give_tick_id: null, give_amount: '0.001',
    get_tick_id: XCHAIN_TICK_ID, get_amount: '100',
    coinpay_action_index: 186,
});



const DEX_ROW_185_TOKEN_GIVE = Object.freeze({
    venue: 'dex', action_index: 185, block_index: 782,
    give_tick_id: XCHAIN_TICK_ID, give_amount: '100',
    get_tick_id: null, get_amount: '0.001',
    coinpay_action_index: 186,
});



function fakeDb(handlers = {}) {
    return {
        calls: [],
        async doQuery(sql, args) {
            this.calls.push({ sql, args });
            if (sql === COIN_ID_SQL)
                return handlers.coinRows === undefined ? [{ id: BTC_COIN_ID, coin: 'BTC' }] : handlers.coinRows;
            if (sql === XCHAIN_TICK_SQL)
                return handlers.tickRows === undefined ? [{ id: XCHAIN_TICK_ID, tick: GAS_TICK }] : handlers.tickRows;
            if (sql === DISPENSE_FILLS_SQL) return handlers.dispenseRows || [];
            if (sql === DEX_FILLS_SQL)      return handlers.dexRows || [];
            throw new Error('unexpected query');
        },
    };
}

const WINDOW_OPTS = { referenceHeight: 3000, confirmationBuffer: 6, windowLength: 1000, gasTick: GAS_TICK, coin: 'BTC' };;

describe('XCHAIN price derivation: fill selection @regression', () => {
    ;

    describe('getWindowFills()', () => {
    it('fails rather than returns empty when the ticker cannot be resolved', async function () {
    // The distinction is the whole point of the ok flag: a failure means
    // abstain, an empty success means carry forward. Collapsing them would
    // let a broken lookup masquerade as a quiet market.
    let res = await getWindowFills(fakeDb({ tickRows: [] }), WINDOW_OPTS);
    assert.strictEqual(res.ok, false);
    assert.ok(res.fills === undefined);
    });

    it('reports an empty window as a success, not a failure', async function () {
    let res = await getWindowFills(fakeDb(), WINDOW_OPTS);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.fills, []);
    assert.strictEqual(res.window.empty, false);
    });
    });
});

describe('XCHAIN price derivation: fill selection @regression', () => {
    ;

    describe('end to end against the formula', function () {
    it('prices a real dispense row at its realized rate', function () {
    let util = new Utility();
    // 0.011 BTC for 5 XCHAIN = 0.0022 BTC each. Reference set to that rate so
    // nothing is winsorized; this asserts selection and formula agree on units.
    let fills = [mapDispenseRow(DISPENSE_ROW_946)];
    let out = deriveXchainRate(util, fills, '0.0022');
    assert.strictEqual(out.rate, '0.00220000');
    assert.strictEqual(out.usedCount, 1);
    assert.strictEqual(out.clampedCount, 0);
    });

    it('volume-weights a dispense and a DEX fill together with no venue preference', function () {
    let util = new Utility();
    // 100 XCHAIN at 0.00001 (DEX) and 5 XCHAIN at 0.0022 (dispense), both
    // inside a band anchored at 0.0001. The dispense is 22x the price but
    // 1/20th the volume, so the DEX fill must dominate.
    let fills = [
    mapDexRow(DEX_ROW_185_COIN_GIVE, XCHAIN_TICK_ID),
    mapDispenseRow(DISPENSE_ROW_946),
    ];
    let out = deriveXchainRate(util, fills, '0.0001', { bandFactor: '100' });
    // (0.001 + 0.011) / 105 = 0.00011428...
    assert.strictEqual(out.rate, '0.00011429');
    assert.strictEqual(out.usedCount, 2);
    assert.strictEqual(out.clampedCount, 0);
    assert.strictEqual(out.totalXchain, '105.00000000');
    });

    it('drops a zero-amount leg at the formula, having let SQL pass it', function () {
    // dispenses row 939 verbatim: give_amount '0' with a real get_amount. SQL
    // deliberately does not judge this numerically (that would put a second
    // numeric engine in a consensus path); bcmath does, and the fill is dropped
    // rather than clamped, so its weight cannot count.
    let util = new Utility();
    let zeroLeg = mapDispenseRow(Object.assign({}, DISPENSE_ROW_946,
    { action_index: 939, block_index: 2009, xchain_amount: '0' }));
    let out = deriveXchainRate(util, [zeroLeg, mapDispenseRow(DISPENSE_ROW_946)], '0.0022');
    assert.strictEqual(out.usedCount, 1);
    assert.strictEqual(out.droppedCount, 1);
    assert.strictEqual(out.rate, '0.00220000');
    });

    it('prices both coinpay orientations identically', function () {
    let util = new Utility();
    let a = deriveXchainRate(util, [mapDexRow(DEX_ROW_185_COIN_GIVE,  XCHAIN_TICK_ID)], '0.00001');
    let b = deriveXchainRate(util, [mapDexRow(DEX_ROW_185_TOKEN_GIVE, XCHAIN_TICK_ID)], '0.00001');
    assert.strictEqual(a.rate, '0.00001000');
    assert.deepStrictEqual(a, b);
    });
    });
});

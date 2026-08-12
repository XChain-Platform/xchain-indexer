/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/xchainPriceQuery.test.js
 *
 * XCHAIN price derivation, fill SELECTION (, step 2 of the spec's
 * implementation sketch). Step 1 covered the formula; this covers which rows the
 * formula is fed, which is where the expensive failures live: a predicate that
 * selects nothing prices XCHAIN off the bootstrap forever WITHOUT failing, and a
 * predicate that selects unsettled obligations prices it off trades nobody paid for.
 *
 * EVERY ROW FIXTURE BELOW IS A REAL ROW, dumped from XChain_BTC_Regtest_Indexer on
 * 2026-07-25, not a hand-written approximation of one. The spec requires
 * this (§10 step 1): hand-written fixtures share their author's misreading of the
 * unit convention, and a satoshi-vs-decimal misread prices fees off by 1e8. Where a
 * fixture needs to be an XCHAIN row, only the ticker id is swapped, to XCHAIN's real
 * id on that database (1); the amount strings and the row shape are untouched.
 */

'use strict';

const assert  = require('assert');
const Utility = require('../../src/utility.js');
const { deriveXchainRate } = require('../../src/xchainPrice.js');
const {
    VENUE_DISPENSE, VENUE_DEX, XCHAIN_TICK_SQL, COIN_ID_SQL, DISPENSE_FILLS_SQL, DEX_FILLS_SQL,
    computeWindowBounds, selectCoinId, selectXchainTickId, mapDispenseRow, mapDexRow, compareFills,
    getWindowFills,
} = require('../../src/xchainPriceQuery.js');

// Real ids on the dumped database.
const BTC_COIN_ID    = 1;
const XCHAIN_TICK_ID = 1;
const GAS_TICK       = 'XCHAIN';

// dispenses row action_index=946 verbatim, with give_tick_id swapped to XCHAIN's.
// Note get_amount's trailing-zero padding ('0.01100000') against a bare give_amount
// ('5'): the two conventions coexist in one row, which is why nothing string-compares.
const DISPENSE_ROW_946 = Object.freeze({
    venue: 'dispense', action_index: 946, block_index: 2018,
    xchain_amount: '5', coin_amount: '0.01100000',
});

// order_matches row action_index=185 verbatim (BTC give / token get), with
// get_tick_id swapped to XCHAIN's, carrying the block_index of coinpays row 186 -
// the payment that settled it at block 782, six blocks after the match at 776.
const DEX_ROW_185_COIN_GIVE = Object.freeze({
    venue: 'dex', action_index: 185, block_index: 782,
    give_tick_id: null, give_amount: '0.001',
    get_tick_id: XCHAIN_TICK_ID, get_amount: '100',
    coinpay_action_index: 186,
});

// The same fill in the opposite orientation, which the order book produces whenever
// the XCHAIN seller is the one whose order was resting.
const DEX_ROW_185_TOKEN_GIVE = Object.freeze({
    venue: 'dex', action_index: 185, block_index: 782,
    give_tick_id: XCHAIN_TICK_ID, give_amount: '100',
    get_tick_id: null, get_amount: '0.001',
    coinpay_action_index: 186,
});

// A db double. Records every query so the tests can assert on the ARGUMENTS a
// consensus predicate was run with, not merely on the rows it returned.
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

const WINDOW_OPTS = { referenceHeight: 3000, confirmationBuffer: 6, windowLength: 1000, gasTick: GAS_TICK, coin: 'BTC' };

describe('XCHAIN price derivation: fill selection @regression', function () {

    describe('computeWindowBounds()', function () {
        it('is (H - K - W, H - K], exclusive low and inclusive high', function () {
            assert.deepStrictEqual(computeWindowBounds(3000, 6, 1000),
                { empty: false, fromBlockExclusive: 1994, toBlockInclusive: 2994 });
        });

        it('holds the confirmation buffer back from the reference height', function () {
            // The whole point of K: the top of the window is never the tip, so a
            // fill that a shallow reorg can still remove is never inside it.
            let w = computeWindowBounds(3000, 6, 1000);
            assert.strictEqual(3000 - w.toBlockInclusive, 6);
        });

        it('tiles consecutive rounds without counting a boundary block twice', function () {
            // Round R's window ends where round R-1's begins. A block equal to the
            // shared bound belongs to exactly one of them, because the low bound is
            // exclusive and the high bound is inclusive.
            let earlier = computeWindowBounds(2000, 6, 1000);
            let later   = computeWindowBounds(3000, 6, 1000);
            assert.strictEqual(later.fromBlockExclusive, earlier.toBlockInclusive);
            assert.strictEqual(later.fromBlockExclusive, 1994);
        });

        it('clamps the lower bound at 0 on a young chain rather than going negative', function () {
            assert.deepStrictEqual(computeWindowBounds(100, 6, 1000),
                { empty: false, fromBlockExclusive: 0, toBlockInclusive: 94 });
        });

        it('is empty when the chain is younger than the confirmation buffer', function () {
            assert.strictEqual(computeWindowBounds(6, 6, 1000).empty, true);
            assert.strictEqual(computeWindowBounds(3, 6, 1000).empty, true);
            assert.strictEqual(computeWindowBounds(0, 6, 1000).empty, true);
        });

        it('is empty rather than wrong on a malformed parameter', function () {
            // These are consensus constants; a NaN reaching the SQL would select an
            // arbitrary row set. Refusing is the only safe reading.
            assert.strictEqual(computeWindowBounds(NaN, 6, 1000).empty, true);
            assert.strictEqual(computeWindowBounds(3000, -1, 1000).empty, true);
            assert.strictEqual(computeWindowBounds(3000, 6, 0).empty, true);
            assert.strictEqual(computeWindowBounds(3000.5, 6, 1000).empty, true);
            assert.strictEqual(computeWindowBounds(3000, 6, null).empty, true);
        });
    });

    describe('selectXchainTickId()', function () {
        it('accepts exactly one exactly-named row', function () {
            assert.deepStrictEqual(selectXchainTickId([{ id: 1, tick: 'XCHAIN' }], 'XCHAIN'),
                { ok: true, tickId: 1 });
        });

        it('refuses an empty result rather than deriving over an empty window', function () {
            // Pre-mint this is the honest state of every chain. Abstaining keeps the
            // bootstrap in force; guessing a ticker id would price fees off some
            // other token's order book.
            assert.strictEqual(selectXchainTickId([], 'XCHAIN').ok, false);
        });

        it('refuses an ambiguous result', function () {
            assert.strictEqual(selectXchainTickId([{ id: 1, tick: 'XCHAIN' }, { id: 9, tick: 'XCHAIN' }], 'XCHAIN').ok, false);
        });

        it('refuses a row whose tick is not byte-identical to the reserved name', function () {
            // index_tickers is utf8mb4_bin today, so a case variant cannot match. This
            // asserts the code does not DEPEND on that: a collation change must break
            // the derivation loudly instead of quietly repricing XCHAIN off "xchain".
            assert.strictEqual(selectXchainTickId([{ id: 2, tick: 'xchain' }], 'XCHAIN').ok, false);
            assert.strictEqual(selectXchainTickId([{ id: 3, tick: 'XCHAIN.SUB' }], 'XCHAIN').ok, false);
        });

        it('refuses a non-positive or unparseable id', function () {
            assert.strictEqual(selectXchainTickId([{ id: 0, tick: 'XCHAIN' }], 'XCHAIN').ok, false);
            assert.strictEqual(selectXchainTickId([{ id: 'abc', tick: 'XCHAIN' }], 'XCHAIN').ok, false);
        });
    });

    describe('row mapping', function () {
        it('maps a real dispense row to its XCHAIN and coin legs', function () {
            assert.deepStrictEqual(mapDispenseRow(DISPENSE_ROW_946), {
                venue: VENUE_DISPENSE, actionIndex: 946, blockIndex: 2018,
                xchainAmount: '5', coinAmount: '0.01100000',
            });
        });

        it('reads BOTH coinpay orientations to the same fill', function () {
            // The economics do not care which side of the book rested first; a fixed
            // column read would invert the rate for half of all DEX volume.
            let a = mapDexRow(DEX_ROW_185_COIN_GIVE,  XCHAIN_TICK_ID);
            let b = mapDexRow(DEX_ROW_185_TOKEN_GIVE, XCHAIN_TICK_ID);
            assert.strictEqual(a.xchainAmount, '100');
            assert.strictEqual(a.coinAmount,   '0.001');
            assert.deepStrictEqual(a, b);
            assert.strictEqual(a.venue, VENUE_DEX);
        });

        it('dates a coinpay fill by its settlement block, not the match block', function () {
            // Match 185 was created at 776 and paid at 782. Windowing on 776 would
            // make a historical window mutable: unpaid for one validator, paid for
            // another, same height range, different fill set, forked pair.
            assert.strictEqual(mapDexRow(DEX_ROW_185_COIN_GIVE, XCHAIN_TICK_ID).blockIndex, 782);
        });

        it('drops a token-for-token match (neither side is the native coin)', function () {
            let tokenForToken = Object.assign({}, DEX_ROW_185_COIN_GIVE, { give_tick_id: 33 });
            assert.strictEqual(mapDexRow(tokenForToken, XCHAIN_TICK_ID), null);
        });

        it('drops a match in which neither side is XCHAIN', function () {
            assert.strictEqual(mapDexRow(DEX_ROW_185_COIN_GIVE, 999), null);
        });

        it('drops a match with no token side at all', function () {
            let bothNull = Object.assign({}, DEX_ROW_185_COIN_GIVE, { get_tick_id: null });
            assert.strictEqual(mapDexRow(bothNull, XCHAIN_TICK_ID), null);
        });

        it('treats a tick id as a number however the driver returned it', function () {
            // mariadb hands BIGINT back as a number here but as a string elsewhere in
            // this codebase; a === against the raw value would silently drop every fill.
            let stringy = Object.assign({}, DEX_ROW_185_TOKEN_GIVE, { give_tick_id: String(XCHAIN_TICK_ID) });
            assert.strictEqual(mapDexRow(stringy, XCHAIN_TICK_ID).xchainAmount, '100');
        });
    });

    describe('the SQL predicates', function () {
        it('anchors DEX settlement on coinpays, never on order_matches.status_id', function () {
            // THE regression this file exists for. A coinpay match's own status is
            // stamped 'pending_coinpay' at creation and never updated - row 185 still
            // reads pending six blocks after it was paid in full. Filtering the match
            // row on status='valid' selects ZERO rows on every chain and fails
            // silently, because an empty fill set is indistinguishable from a quiet
            // market and simply carries the bootstrap forward.
            assert.ok(/JOIN\s+coinpays\s+cp/.test(DEX_FILLS_SQL), 'DEX fills must join coinpays');
            assert.ok(/cs\.status\s*=\s*'valid'/.test(DEX_FILLS_SQL), 'settlement is judged valid on the coinpay row');
            assert.ok(!/m\.status_id/.test(DEX_FILLS_SQL), 'the match row status is never a settlement signal');
            assert.ok(!/pending_coinpay/.test(DEX_FILLS_SQL), 'a pending obligation is not a trade');
        });

        it('takes the DEX window bound from the settlement block', function () {
            assert.ok(/cp\.block_index\s*>/.test(DEX_FILLS_SQL) && /cp\.block_index\s*<=/.test(DEX_FILLS_SQL));
            assert.ok(!/m\.block_index/.test(DEX_FILLS_SQL));
        });

        it('excludes token-for-token dispenses and cross-chain fills', function () {
            assert.ok(/d\.get_tick_id\s+IS\s+NULL/.test(DISPENSE_FILLS_SQL), 'token-priced dispenses are not XCHAIN/coin fills');
            assert.ok(/d\.give_coin_id\s*=\s*\?/.test(DISPENSE_FILLS_SQL) && /d\.get_coin_id\s*=\s*\?/.test(DISPENSE_FILLS_SQL));
            assert.ok(/m\.give_coin_id\s*=\s*\?/.test(DEX_FILLS_SQL) && /m\.get_coin_id\s*=\s*\?/.test(DEX_FILLS_SQL));
        });

        it('judges a dispense on its own status row', function () {
            // 14 of the 57 dumped dispenses are 'invalid: no matching oracle price'.
            assert.ok(/s\.status\s*=\s*'valid'/.test(DISPENSE_FILLS_SQL));
        });

        it('puts no numeric predicate in SQL', function () {
            // Positivity belongs to the one bcmath implementation, not to whatever
            // MariaDB build a validator happens to run. SQL drops only the
            // string-degenerate rows, which every engine agrees on.
            for (let sql of [DISPENSE_FILLS_SQL, DEX_FILLS_SQL]) {
                assert.ok(!/CAST\s*\(/i.test(sql), 'no CAST in a consensus predicate');
                assert.ok(!/DECIMAL/i.test(sql),   'no DECIMAL in a consensus predicate');
                assert.ok(/_amount\s+IS\s+NOT\s+NULL/.test(sql) && /_amount\s*<>\s*''/.test(sql));
            }
        });

        it('restricts the ticker lookup to the deterministic set', function () {
            assert.ok(/block_index\s+IS\s+NOT\s+NULL/.test(XCHAIN_TICK_SQL));
        });
    });

    describe('getWindowFills()', function () {
        it('runs no query at all when the window is empty', async function () {
            let db = fakeDb();
            let res = await getWindowFills(db, Object.assign({}, WINDOW_OPTS, { referenceHeight: 3 }));
            assert.strictEqual(res.ok, true);
            assert.deepStrictEqual(res.fills, []);
            assert.strictEqual(res.window.empty, true);
            assert.strictEqual(db.calls.length, 0);
        });

        it('passes the computed bounds and resolved ids into both predicates', async function () {
            let db = fakeDb();
            await getWindowFills(db, WINDOW_OPTS);
            let dispense = db.calls.find((c) => c.sql === DISPENSE_FILLS_SQL);
            let dex      = db.calls.find((c) => c.sql === DEX_FILLS_SQL);
            assert.deepStrictEqual(dispense.args, [XCHAIN_TICK_ID, BTC_COIN_ID, BTC_COIN_ID, 1994, 2994]);
            assert.deepStrictEqual(dex.args,      [BTC_COIN_ID, BTC_COIN_ID, XCHAIN_TICK_ID, XCHAIN_TICK_ID, 1994, 2994]);
        });

        it('merges both venues into one canonically ordered set', async function () {
            let db = fakeDb({
                dispenseRows: [Object.assign({}, DISPENSE_ROW_946, { block_index: 2500 }), DISPENSE_ROW_946],
                dexRows:      [Object.assign({}, DEX_ROW_185_COIN_GIVE, { block_index: 2200 })],
            });
            let res = await getWindowFills(db, WINDOW_OPTS);
            assert.strictEqual(res.ok, true);
            assert.deepStrictEqual(res.fills.map((f) => f.blockIndex), [2018, 2200, 2500]);
            assert.deepStrictEqual(res.fills.map((f) => f.venue), [VENUE_DISPENSE, VENUE_DEX, VENUE_DISPENSE]);
        });

        it('orders identically whatever order the driver returned rows in', async function () {
            // The formula sums a bignumber chain, so an order difference between two
            // nodes is a result difference, and "nearly equal" is a forked fee input.
            let rows = [
                Object.assign({}, DISPENSE_ROW_946, { block_index: 2500, action_index: 950 }),
                Object.assign({}, DISPENSE_ROW_946, { block_index: 2018, action_index: 946 }),
                Object.assign({}, DISPENSE_ROW_946, { block_index: 2018, action_index: 944 }),
            ];
            let forward  = await getWindowFills(fakeDb({ dispenseRows: rows }), WINDOW_OPTS);
            let reversed = await getWindowFills(fakeDb({ dispenseRows: rows.slice().reverse() }), WINDOW_OPTS);
            assert.deepStrictEqual(forward.fills, reversed.fills);
            assert.deepStrictEqual(forward.fills.map((f) => f.actionIndex), [944, 946, 950]);
        });

        it('is a total order even on two fills sharing a block and action index', function () {
            let a = { blockIndex: 1, actionIndex: 1, venue: VENUE_DEX };
            let b = { blockIndex: 1, actionIndex: 1, venue: VENUE_DISPENSE };
            assert.strictEqual(compareFills(a, b) < 0, true);
            assert.strictEqual(compareFills(b, a) > 0, true);
            assert.strictEqual(compareFills(a, a), 0);
        });

        it('fails rather than returns empty when the coin is unknown', async function () {
            let res = await getWindowFills(fakeDb({ coinRows: [] }), WINDOW_OPTS);
            assert.strictEqual(res.ok, false);
            assert.match(res.error, /index_coins/);
        });

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

'use strict';

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
 * getOrderInfo / getSwapInfo coin-filter contract.
 *
 * These resolve an order/swap by its (locally-unique) action_index. The optional
 * `coin` argument matches the offer's GET coin: for a SAME-chain offer get_coin is
 * the local coin; for a CROSS-chain offer get_coin is the counterparty coin.
 *
 * The cancel / edit / expire / sweep paths operate on a LOCAL offer by index and
 * must pass `null`; they cannot assume the get_coin is local. Passing the local
 * COIN there (the old behavior) silently excluded every cross-chain offer, so a
 * cross-chain ORDER/SWAP could never be cancelled, expired, or swept. The strict
 * paths (cross_settle / order_match / sweep-of-same-chain / coinpay) still pass a
 * coin and keep the get_coin assertion.
 *
 * This locks both shapes at the query-construction layer (no live DB): with a coin,
 * the WHERE carries `c1.coin=?` and the bind args lead with the coin; with null, the
 * clause is gone and the lookup is by action_index alone.
 *
 ********************************************************************/

const assert   = require('assert');
const Database = require('../../src/db');

// Minimal stand-in: capture the (query, args) the method builds, return no rows so
// the method short-circuits to `false` without any further queries or dependencies.
function makeDb(capture){
    return {
        config: { COIN: 'LTC' },
        doQuery: async (q, a) => { capture.query = q; capture.args = a; return []; },
    };
}

const COIN_CLAUSE = /c1\.coin\s*=\s*\?/;

[
    { name: 'getOrderInfo', fn: Database.prototype.getOrderInfo, pk: 'o1.action_index' },
    { name: 'getSwapInfo',  fn: Database.prototype.getSwapInfo,  pk: 's1.action_index' },
].forEach(({ name, fn, pk }) => {

    describe(name + '() coin filter @regression @tier1', function () {

        it('with a coin: keeps the c1.coin=? clause and binds [coin, action_index]', async function () {
            const cap = {};
            await fn.call(makeDb(cap), 'DOGE', 42);
            assert.ok(COIN_CLAUSE.test(cap.query), name + ' should constrain by c1.coin when a coin is given');
            assert.ok(new RegExp(pk.replace('.', '\\.') + '\\s*=\\s*\\?').test(cap.query), 'should still match by action_index');
            assert.deepStrictEqual(cap.args, ['DOGE', 42]);
        });

        it('with null coin: drops the c1.coin=? clause and binds [action_index] only', async function () {
            const cap = {};
            await fn.call(makeDb(cap), null, 42);
            assert.ok(!COIN_CLAUSE.test(cap.query),
                name + ' must NOT constrain by c1.coin when coin is null (that is what hid cross-chain offers from cancel/expire/sweep)');
            assert.ok(new RegExp(pk.replace('.', '\\.') + '\\s*=\\s*\\?').test(cap.query), 'should match by action_index');
            assert.deepStrictEqual(cap.args, [42]);
        });

        it('with null coin: a single bind placeholder fewer than the coin form', async function () {
            const withCoin = {}; await fn.call(makeDb(withCoin), 'DOGE', 42);
            const noCoin   = {}; await fn.call(makeDb(noCoin), null, 42);
            const count = (s) => (s.match(/\?/g) || []).length;
            assert.strictEqual(count(noCoin.query), count(withCoin.query) - 1,
                'null-coin query should have exactly one fewer ? placeholder');
        });
    });
});

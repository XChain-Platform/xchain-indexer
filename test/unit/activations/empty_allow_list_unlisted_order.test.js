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
 ********************************************************************/
// an UNLISTED order read through the real getOrderInfo row
// mapping (NULL allow_list -> Number(null) = 0) meets EMPTY_ALLOW_LIST_DENIES.
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';
const sinon = require("sinon");
const assert = require('assert');
const { createBaseData, createMockIndexer } = require("../../fixtures/mocks");
const { stubGate } = require("../../helpers/gate_modules.js");
const H = require("../../unit/actions/market/order_match.test/helpers/order_match_harness.js");
const orderInfoDb = require("../../../src/db/orders/order_info.js");
const swapInfoDb = require("../../../src/db/swaps/swap_info.js");
const KEY = 'empty_allow_list_denies_activation.EMPTY_ALLOW_LIST_DENIES';

let indexer, orderMatch;
describe('unlisted order vs EMPTY_ALLOW_LIST_DENIES', function () {
    H.useOrderMatchHarness((h) => { ({ indexer, orderMatch } = h); });

    it('real getOrderInfo maps a NULL allow_list to 0', async function () {
        const mi = createMockIndexer();
        const ctx = Object.assign({}, orderInfoDb, { config: mi.config, util: mi.util,
            doQuery: async (q) => /order_edits/.test(q) ? [] :
                [{ action_index: 7, block_index: 1, block_time: 1, allow_list: null, block_list: null,
                   give_amount: '1', get_amount: '1', give_remaining: '1', get_remaining: '1' }],
            getOrderAmountsRemaining: async () => [0,0,'1',0,0,'1'] });
        const o = await ctx.getOrderInfo(null, 7);
        assert.strictEqual(o.ALLOW_LIST, 0);
        const sctx = Object.assign({}, swapInfoDb, { config: mi.config, util: mi.util,
            doQuery: async (q) => /swap_edits/.test(q) ? [] :
                [{ action_index: 8, block_index: 1, block_time: 1, allow_list: null, block_list: null }] });
        const s = await sctx.getSwapInfo(null, 8);
        assert.strictEqual(s.ALLOW_LIST, 0);
    });

    for (const gate of [false, true]) {
        it('unlisted orders (ALLOW_LIST 0, getList(0) -> []) match with gate ' + gate, async function () {
            stubGate(sinon, KEY, gate);
            indexer.indexerDb.getOrderInfo.resolves(H.makeOrderInfo({ ALLOW_LIST: 0, BLOCK_LIST: 0 }));
            indexer.indexerDb.findOrderMatches.resolves([H.makeMatchInfo({ ALLOW_LIST: 0, BLOCK_LIST: 0 })]);
            indexer.indexerDb.getList.resolves([]);
            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME: H.BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);
            sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
        });
    }
});

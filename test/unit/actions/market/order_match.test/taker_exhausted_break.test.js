// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Order_Match stops scanning makers once either running taker side is empty,
// while preserving the final transient-list reset of the legacy scan.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const {
    BLOCK_TIME, makeOrderInfo, makeMatchInfo, useOrderMatchHarness,
} = require('./helpers/order_match_harness.js');

let indexer, orderMatch;
const bind = (h) => { ({ indexer, orderMatch } = h); };

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    for(const exhaustedSide of ['GIVE', 'GET']){
        it(`breaks after the taker exhausts its ${exhaustedSide} side`, async function () {
            const orderInfo = exhaustedSide === 'GIVE'
                ? makeOrderInfo({ GIVE_REMAINING: '5', GET_REMAINING: '100' })
                : makeOrderInfo({ GIVE_REMAINING: '10', GET_REMAINING: '50' });
            const matches = [
                makeMatchInfo({ ACTION_INDEX: 2, GIVE_REMAINING: '50', GET_REMAINING: '5' }),
                makeMatchInfo({ ACTION_INDEX: 3, GET_ADDRESS: 'mMaker2bbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
                makeMatchInfo({ ACTION_INDEX: 4, GET_ADDRESS: 'mMaker3ccccccccccccccccccccccccccc' }),
            ];
            indexer.indexerDb.getOrderInfo.resolves(orderInfo);
            indexer.indexerDb.findOrderMatches.resolves(matches);

            const fillSpy = sinon.spy(orderMatch, 'fillMatch');
            const settleSpy = sinon.spy(orderMatch, 'settleFill');
            const resetSpy = sinon.spy(indexer.util, 'resetLists');

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);

            sinon.assert.calledOnce(fillSpy);
            sinon.assert.calledOnce(settleSpy);
            sinon.assert.calledTwice(resetSpy);
            assert.strictEqual(settleSpy.firstCall.args[2], matches[0]);
            assert.deepStrictEqual(indexer.util.getAddressesList(), {});
            assert.deepStrictEqual(indexer.util.getTickersList(), []);
        });
    }
});

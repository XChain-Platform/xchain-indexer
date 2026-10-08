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

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const gateRegistry = require('../../../../src/protocol_changes.js');
const crossChainOffers = require('../../../../src/db/orders/cross_chain_offers.js');
const { buildOrdersRpc } = require('../../../../src/api/rpc/orders.js');

const GATE = 'cross_chain_offer_list_export_activation.CROSS_CHAIN_OFFER_LIST_EXPORT';

function editReader(edits){
    return {
        getOrderEdits: sinon.stub().callsFake(async actionIndex => edits.order[actionIndex]),
        getSwapEdits: sinon.stub().callsFake(async actionIndex => edits.swap[actionIndex])
    };
}

function rpcFixture(offers, edits){
    let readers = editReader(edits);
    let view = {
        getLatestBlockIndex: sinon.stub().resolves(80),
        getPushGeneration: sinon.stub().resolves(3),
        getBlockTime: sinon.stub().resolves(1700000000),
        getOpenCrossChainOffers: sinon.stub().resolves(offers),
        getTickerId: sinon.stub().resolves(null),
        applyEffectiveOpenCrossChainOfferLists: sinon.spy(async rows =>
            crossChainOffers.applyEffectiveOpenCrossChainOfferLists.call(readers, rows))
    };
    let indexer = {
        config: { COIN: 'BTC', NETWORK: 'regtest', COIN_DECIMALS: 8 },
        indexerDb: { apiView: () => view },
        util: { isNull: value => value === null || value === undefined }
    };
    return { rpc: buildOrdersRpc({ indexer }), readers, view };
}

describe('effective lists in open cross-chain orders', function(){
    afterEach(function(){
        sinon.restore();
    });

    it('resolves edited allow and block lists for orders and swaps', async function(){
        let offers = [
            { kind: 'order', action_index: 11, allow_list: 1, block_list: 2 },
            { kind: 'swap', action_index: 12, allow_list: 3, block_list: 4 }
        ];
        let readers = editReader({
            order: { 11: { allow_list: 21, block_list: false } },
            swap: { 12: { allow_list: false, block_list: 0 } }
        });

        let result = await crossChainOffers.applyEffectiveOpenCrossChainOfferLists.call(readers, offers);

        assert.strictEqual(result, offers);
        assert.deepStrictEqual(
            offers.map(({ allow_list, block_list }) => ({ allow_list, block_list })),
            [
                { allow_list: 21, block_list: 2 },
                { allow_list: 3, block_list: null }
            ]
        );
        sinon.assert.calledOnceWithExactly(readers.getOrderEdits, 11);
        sinon.assert.calledOnceWithExactly(readers.getSwapEdits, 12);
    });

    it('leaves creation list ids unchanged below the export gate', async function(){
        sinon.stub(gateRegistry, 'activeAt').returns(false);
        let offers = [{ kind: 'order', action_index: 11, give_tick: null, allow_list: 1, block_list: 2 }];
        let { rpc, view } = rpcFixture(offers, {
            order: { 11: { allow_list: 21, block_list: 22 } },
            swap: {}
        });

        let response = await rpc.getopencrosschainorders({});

        assert.deepStrictEqual(
            { allow_list: response.orders[0].allow_list, block_list: response.orders[0].block_list },
            { allow_list: 1, block_list: 2 }
        );
        sinon.assert.notCalled(view.applyEffectiveOpenCrossChainOfferLists);
        sinon.assert.calledOnceWithExactly(gateRegistry.activeAt, GATE, 'regtest', 'BTC', 80, null);
    });

    it('exports edited list ids at and above the export gate', async function(){
        sinon.stub(gateRegistry, 'activeAt').returns(true);
        let offers = [
            { kind: 'order', action_index: 11, give_tick: null, allow_list: 1, block_list: 2 },
            { kind: 'swap', action_index: 12, give_tick: null, allow_list: 3, block_list: 4 }
        ];
        let { rpc, readers, view } = rpcFixture(offers, {
            order: { 11: { allow_list: 21, block_list: false } },
            swap: { 12: { allow_list: false, block_list: 22 } }
        });

        let response = await rpc.getopencrosschainorders({});

        assert.deepStrictEqual(
            response.orders.map(({ allow_list, block_list }) => ({ allow_list, block_list })),
            [
                { allow_list: 21, block_list: 2 },
                { allow_list: 3, block_list: 22 }
            ]
        );
        sinon.assert.calledOnceWithExactly(view.applyEffectiveOpenCrossChainOfferLists, offers);
        sinon.assert.calledOnceWithExactly(readers.getOrderEdits, 11);
        sinon.assert.calledOnceWithExactly(readers.getSwapEdits, 12);
        sinon.assert.calledOnceWithExactly(gateRegistry.activeAt, GATE, 'regtest', 'BTC', 80, null);
    });
});

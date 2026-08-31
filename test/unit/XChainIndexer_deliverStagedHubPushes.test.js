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
 * Unit: XChainIndexer._deliverStagedHubPushes() live-delivery dispatch
 *
 * Covers the SECOND of the two dispatch arms a price_batch push needs
 * (the first is HubPushQueue._attempt, tested in hub_push_queue.test.js).
 * An unknown push_type is left on the durable row forever rather than
 * erroring, so a missing arm here is a silent permanent stall for every
 * PRICE batch, not a visible failure.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert         = require('assert');
const sinon          = require('sinon');
const XChainIndexer  = require('../../src/XChainIndexer.js');

// The constructor only assigns config fields; no DB connection is opened
// synchronously, so a plain `new XChainIndexer()` with stubbed indexerDb/
// hubClient is enough to drive _deliverStagedHubPushes() in isolation.
function makeIndexer(staged, hubClientOpts){
    let indexer = new XChainIndexer();
    indexer.indexerDb = {
        takeStagedHubPushes: sinon.stub().returns(staged || []),
        markHubPushDelivered: sinon.stub().resolves()
    };
    indexer.hubClient = Object.assign({
        pushPriceRound:  sinon.stub().resolves(),
        pushOraclePrice: sinon.stub().resolves(),
        pushPriceBatch:  sinon.stub().resolves()
    }, hubClientOpts || {});
    return indexer;
}

describe('XChainIndexer._deliverStagedHubPushes()', function(){

    afterEach(function(){
        sinon.restore();
    });

    it('does nothing when there is nothing staged', async function(){
        let indexer = makeIndexer([]);
        await indexer._deliverStagedHubPushes();
        assert.strictEqual(indexer.hubClient.pushPriceRound.callCount, 0);
        assert.strictEqual(indexer.hubClient.pushOraclePrice.callCount, 0);
        assert.strictEqual(indexer.hubClient.pushPriceBatch.callCount, 0);
    });

    it('does nothing when hubClient is unset', async function(){
        let indexer = makeIndexer([{ id: 1, pushType: 'price_batch', payload: {} }]);
        indexer.hubClient = null;
        await assert.doesNotReject(() => indexer._deliverStagedHubPushes());
    });

    it('dispatches price_round entries to pushPriceRound', async function(){
        let payload = { round: 5, coin: 'BTC' };
        let indexer = makeIndexer([{ id: 1, pushType: 'price_round', payload }]);
        await indexer._deliverStagedHubPushes();
        assert.strictEqual(indexer.hubClient.pushPriceRound.calledOnceWith(payload), true);
        assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(1), true);
    });

    it('dispatches oracle_price entries to pushOraclePrice', async function(){
        let payload = { tick: 'AAA', price: '1.00' };
        let indexer = makeIndexer([{ id: 2, pushType: 'oracle_price', payload }]);
        await indexer._deliverStagedHubPushes();
        assert.strictEqual(indexer.hubClient.pushOraclePrice.calledOnceWith(payload), true);
        assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(2), true);
    });

    // ─── price_batch (PRICE batch push, D12): the arm this row adds ─────
    it('dispatches price_batch entries to pushPriceBatch and marks delivered', async function(){
        let payload = {
            source_chain:     'BTC',
            first_round:      1,
            last_round:       6,
            btc_block_height: 900000,
            rounds:           [{ round: 1, timestamp: 1700000000, btc_block_height: 900000, pairs: [] }],
            sigs:             [{ pubkey: 'a', sig: 'b' }],
            action_index:     42,
            block_index:      7,
            push_generation:  0,
            block_time:       1700000600
        };
        let indexer = makeIndexer([{ id: 3, pushType: 'price_batch', payload }]);
        await indexer._deliverStagedHubPushes();
        assert.strictEqual(indexer.hubClient.pushPriceBatch.calledOnce, true);
        assert.strictEqual(indexer.hubClient.pushPriceBatch.firstCall.args[0], payload);
        assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(3), true);
    });

    it('leaves the durable row alone (never marks delivered) when pushPriceBatch live delivery fails', async function(){
        let indexer = makeIndexer(
            [{ id: 4, pushType: 'price_batch', payload: { first_round: 1, last_round: 6 } }],
            { pushPriceBatch: sinon.stub().rejects(new Error('hub down')) }
        );
        await indexer._deliverStagedHubPushes();
        assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0);
    });

    it('skips an unknown pushType without calling any hub method or marking delivered', async function(){
        let indexer = makeIndexer([{ id: 5, pushType: 'mystery_type', payload: {} }]);
        await indexer._deliverStagedHubPushes();
        assert.strictEqual(indexer.hubClient.pushPriceRound.callCount, 0);
        assert.strictEqual(indexer.hubClient.pushOraclePrice.callCount, 0);
        assert.strictEqual(indexer.hubClient.pushPriceBatch.callCount, 0);
        assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0);
    });

    it('processes multiple staged entries of mixed pushType independently', async function(){
        let indexer = makeIndexer([
            { id: 6, pushType: 'price_round', payload: { round: 1 } },
            { id: 7, pushType: 'price_batch',  payload: { first_round: 2, last_round: 7 } },
            { id: 8, pushType: 'oracle_price', payload: { tick: 'BBB' } }
        ]);
        await indexer._deliverStagedHubPushes();
        assert.strictEqual(indexer.hubClient.pushPriceRound.calledOnce, true);
        assert.strictEqual(indexer.hubClient.pushPriceBatch.calledOnce, true);
        assert.strictEqual(indexer.hubClient.pushOraclePrice.calledOnce, true);
        assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 3);
    });
});

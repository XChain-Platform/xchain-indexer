// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The two LIVE post-commit delivery paths (block pushes and rollback retractions) settle
// a durable row through the same delivered_to fan-out the queue drain uses: with several
// unpinned candidate hubs, reaching the current hub records that hub and keeps the row
// for the others; pinned or queue-less nodes keep the plain delete.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const HubPushQueue = require('../../../../src/hub/hub_push_queue.js');
const XChainIndexer = require('../../../../src/XChainIndexer.js');
const rollbackCommit = require('../../../../src/rollback/commit.js');

const HUB_A = 'http://hub-a.test';
const HUB_B = 'http://hub-b.test';

// A hub client whose every RPC records the address it was routed to.
function makeHubClient(calls){
    let client = {
        enabled: true, hubUrl: '', apiKey: 'k', reorgApiKey: 'rk',
        call: sinon.stub().callsFake(async (method, params, key, address) => {
            calls.push({ method, address });
            return { accepted: true };
        })
    };
    client.pushPriceBatch = function(payload){ return this.call('pushpricebatch', payload, this.apiKey); };
    client.retractPriceRange = function(coin, first){ return this.call('pushpricereorg', { coin, first }, this.reorgApiKey); };
    return client;
}

// An indexerDb double whose pending_hub_pushes rows keep a delivered_to list.
function makeIndexerDb(deliveredTo){
    return {
        markHubPushDelivered: sinon.stub().resolves(),
        recordHubPushAttempt: sinon.stub().resolves(),
        poolQuery: sinon.stub().callsFake(async (sql, params) => {
            if(/SELECT delivered_to FROM pending_hub_pushes/.test(sql))
                return [{ delivered_to: JSON.stringify(deliveredTo.get(params[0]) || []) }];
            if(/SET delivered_to = JSON_ARRAY_APPEND/.test(sql)){
                let list = deliveredTo.get(params[1]) || [];
                if(!list.includes(params[0])) list.push(params[0]);
                deliveredTo.set(params[1], list);
                return { affectedRows: 1 };
            }
            throw new Error('unexpected SQL: ' + sql);
        })
    };
}

// An indexer with a running queue over the given selector, current hub HUB_A.
function makeIndexer(selector, staged){
    let calls = [];
    let deliveredTo = new Map();
    let indexer = new XChainIndexer();
    indexer.hubClient = makeHubClient(calls);
    indexer.indexerDb = makeIndexerDb(deliveredTo);
    indexer.indexerDb.takeStagedHubPushes = sinon.stub().returns(staged || []);
    indexer.hubSelector = selector;
    indexer.hubPushQueue = new HubPushQueue(indexer, { selector });
    return { indexer, calls, deliveredTo };
}

const unpinned = () => ({ current: () => HUB_A, status: () => ({ current: HUB_A, candidates: [HUB_A, HUB_B], pinned: false }) });
const pinned   = () => ({ current: () => HUB_A, status: () => ({ current: HUB_A, candidates: [HUB_A], pinned: true }) });

describe('live hub push delivery settles through the delivered_to fan-out @regression @tier1', function(){
    afterEach(function(){ sinon.restore(); });

    it('block push: reaching the current hub records it and keeps the row for the other candidate', async function(){
        let { indexer, calls, deliveredTo } = makeIndexer(unpinned(), [{ id: 7, pushType: 'price_batch', payload: { a: 1 } }]);
        await indexer.deliverStagedHubPushes();
        assert.deepStrictEqual(calls.map(c => c.address), [HUB_A], 'the live send is bound to the current hub');
        assert.deepStrictEqual(deliveredTo.get(7), [HUB_A]);
        assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0,
            'the row was dropped after reaching one of two unpinned hubs');
    });

    it('block push: the drain then completes the fan-out and drops the row', async function(){
        let { indexer, calls, deliveredTo } = makeIndexer(unpinned(), [{ id: 7, pushType: 'price_batch', payload: { a: 1 } }]);
        await indexer.deliverStagedHubPushes();
        await indexer.hubPushQueue.attempt({ id: 7, push_type: 'price_batch', payload: JSON.stringify({ a: 1 }), attempts: 0 });
        assert.deepStrictEqual(calls.map(c => c.address), [HUB_A, HUB_B], 'the drain skips the hub the live send reached');
        assert.deepStrictEqual(deliveredTo.get(7), [HUB_A, HUB_B]);
        assert.ok(indexer.indexerDb.markHubPushDelivered.calledOnceWith(7));
    });

    it('block push: a pinned node still drops the row on the first success (control)', async function(){
        let { indexer } = makeIndexer(pinned(), [{ id: 8, pushType: 'price_batch', payload: { a: 1 } }]);
        await indexer.deliverStagedHubPushes();
        assert.ok(indexer.indexerDb.markHubPushDelivered.calledOnceWith(8));
        assert.strictEqual(indexer.indexerDb.poolQuery.callCount, 0, 'a pinned node records no delivered_to');
    });

    it('rollback retraction: reaching the current hub records it and keeps the row for the other candidate', async function(){
        let { indexer, calls, deliveredTo } = makeIndexer(unpinned());
        let rb = Object.assign(Object.create(rollbackCommit), {
            config: { COIN: 'BTC' }, hubClient: indexer.hubClient, indexerDb: indexer.indexerDb,
            hubPushQueue: null, indexer
        });
        await rb.deliverStagedRetractions(50, 3, [{ pushType: 'price_retraction', id: 11 }]);
        assert.deepStrictEqual(calls.map(c => c.address), [HUB_A]);
        assert.deepStrictEqual(deliveredTo.get(11), [HUB_A]);
        assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0,
            'the retraction row was dropped after reaching one of two unpinned hubs');
    });

    it('rollback retraction: a pinned node still drops the row on success (control)', async function(){
        let { indexer } = makeIndexer(pinned());
        let rb = Object.assign(Object.create(rollbackCommit), {
            config: { COIN: 'BTC' }, hubClient: indexer.hubClient, indexerDb: indexer.indexerDb,
            hubPushQueue: null, indexer
        });
        await rb.deliverStagedRetractions(50, 3, [{ pushType: 'price_retraction', id: 12 }]);
        assert.ok(indexer.indexerDb.markHubPushDelivered.calledOnceWith(12));
    });
});

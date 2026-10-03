// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const HubPushQueue = require('../../../../src/hub/hub_push_queue.js');
const { makeRow } = require('./helpers/fixtures.js');

function makeFanoutIndexer(initialCandidates, downAddresses){
    let candidates = initialCandidates.slice();
    let calls = [];
    let deliveries = new Map();
    let down = new Set(downAddresses || []);

    let hubClient = {
        enabled: true,
        hubUrl: candidates[0],
        apiKey: 'push-key',
        reorgApiKey: 'reorg-key',
        call: sinon.stub().callsFake(async function(method, params, key, address){
            calls.push({ method, params, key, address });
            if(down.has(address)) throw new Error('hub down');
            return { accepted: true };
        }),
        pushPriceRound(payload){
            return this.call('pushpriceround', payload, this.apiKey);
        },
        retractPriceRange(coin, first, last, generation){
            let params = { source_chain: coin, from_action_index: first };
            if(last != null) params.to_action_index = last;
            if(generation != null) params.retraction_generation = generation;
            return this.call('pushpricereorg', params, this.reorgApiKey);
        }
    };

    let indexerDb = {
        markHubPushDelivered: sinon.stub().resolves(),
        recordHubPushAttempt: sinon.stub().resolves(),
        poolQuery: sinon.stub().callsFake(async function(sql, params){
            if(/INSERT IGNORE INTO hub_push_deliveries/.test(sql)){
                for(let i = 0; i < params.length; i += 2){
                    let key = params[i] + '|' + params[i + 1];
                    if(!deliveries.has(key)) deliveries.set(key, {
                        push_id: params[i], hub_address: params[i + 1], status: 'pending',
                        attempts: 0, last_attempted_at: null, last_error: null
                    });
                }
                return { affectedRows: params.length / 2 };
            }
            if(/SELECT push_id, hub_address/.test(sql))
                return [...deliveries.values()].filter(row => row.push_id === params[0]);
            if(/SET status = 'delivered'/.test(sql)){
                let row = deliveries.get(params[0] + '|' + params[1]);
                row.status = 'delivered';
                row.last_attempted_at = new Date();
                row.last_error = null;
                return { affectedRows: 1 };
            }
            if(/SET attempts = attempts \+ 1/.test(sql)){
                let row = deliveries.get(params[1] + '|' + params[2]);
                row.attempts++;
                row.last_attempted_at = new Date();
                row.last_error = params[0];
                return { affectedRows: 1 };
            }
            if(/DELETE FROM hub_push_deliveries/.test(sql)){
                for(let key of [...deliveries.keys()])
                    if(key.startsWith(params[0] + '|')) deliveries.delete(key);
                return { affectedRows: 1 };
            }
            throw new Error('unexpected SQL: ' + sql);
        })
    };

    return {
        indexer: {
            hubClient,
            indexerDb,
            hubSelector: { status: () => ({ candidates: candidates.slice() }) }
        },
        calls,
        deliveries,
        setCandidates(next){ candidates = next.slice(); }
    };
}

describe('HubPushQueue per-hub fan-out', function(){
    afterEach(function(){ sinon.restore(); });

    it('delivers one queued row to both selector candidates', async function(){
        let fixture = makeFanoutIndexer(['http://hub-a', 'http://hub-b']);
        let queue = new HubPushQueue(fixture.indexer);

        await queue.attempt(makeRow({ id: 101 }));

        assert.deepStrictEqual(fixture.calls.map(call => call.address),
            ['http://hub-a', 'http://hub-b']);
        assert.strictEqual(fixture.indexer.indexerDb.markHubPushDelivered.calledWith(101), true);
        assert.strictEqual(fixture.deliveries.size, 0);
    });

    it('keeps only the down hub delivery pending after the other hub acknowledges', async function(){
        let fixture = makeFanoutIndexer(['http://hub-a', 'http://hub-b'], ['http://hub-b']);
        let queue = new HubPushQueue(fixture.indexer);

        await queue.attempt(makeRow({ id: 102 }));

        assert.strictEqual(fixture.deliveries.get('102|http://hub-a').status, 'delivered');
        assert.strictEqual(fixture.deliveries.get('102|http://hub-b').status, 'pending');
        assert.strictEqual(fixture.deliveries.get('102|http://hub-b').attempts, 1);
        assert.strictEqual(fixture.indexer.indexerDb.markHubPushDelivered.callCount, 0);
    });

    it('stops a removed candidate from blocking row completion', async function(){
        let fixture = makeFanoutIndexer(['http://hub-a', 'http://hub-b'], ['http://hub-b']);
        let queue = new HubPushQueue(fixture.indexer);
        let row = makeRow({ id: 103 });
        await queue.attempt(row);

        fixture.setCandidates(['http://hub-a']);
        await queue.attempt(row);

        assert.strictEqual(fixture.indexer.indexerDb.markHubPushDelivered.calledWith(103), true);
        assert.strictEqual(fixture.deliveries.size, 0);
    });

    it('uses the reorg key for every reorg fan-out delivery', async function(){
        let fixture = makeFanoutIndexer(['http://hub-a', 'http://hub-b']);
        let queue = new HubPushQueue(fixture.indexer);
        let payload = { coin: 'BTC', action_index: 20, last_action_index: 25,
            retraction_generation: 4 };

        await queue.attempt(makeRow({ id: 104, push_type: 'price_retraction',
            payload: JSON.stringify(payload) }));

        assert.strictEqual(fixture.calls.length, 2);
        assert.deepStrictEqual(fixture.calls.map(call => call.key), ['reorg-key', 'reorg-key']);
        assert.deepStrictEqual(fixture.calls.map(call => call.address),
            ['http://hub-a', 'http://hub-b']);
    });

    it('keeps pinned selector mode on the existing single-hub path', async function(){
        let fixture = makeFanoutIndexer(['http://hub-a']);
        fixture.indexer.hubSelector.status = () => ({
            pinned: true,
            candidates: ['http://hub-a']
        });
        let queue = new HubPushQueue(fixture.indexer);

        await queue.attempt(makeRow({ id: 105 }));

        assert.strictEqual(fixture.indexer.hubClient.call.calledOnce, true);
        assert.strictEqual(fixture.indexer.indexerDb.poolQuery.callCount, 0);
        assert.strictEqual(fixture.indexer.indexerDb.markHubPushDelivered.calledWith(105), true);
    });
});

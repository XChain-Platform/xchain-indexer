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

function makeFixture(){
    let address = 'http://hub-a.test';
    let deliveries = [];
    let advanceCalls = 0;
    let selector = {
        current: () => address,
        status: () => ({ current: address }),
        advance(){
            advanceCalls += 1;
            address = 'http://hub-b.test';
            return address;
        }
    };
    let hubClient = {
        enabled: true,
        pushPriceRound: sinon.stub().callsFake(async function(){
            deliveries.push(selector.current());
            if(selector.current() === 'http://hub-a.test'){
                let error = new Error('connect ECONNREFUSED');
                error.code = 'ECONNREFUSED';
                throw error;
            }
        })
    };
    let indexerDb = {
        poolQuery: sinon.stub().resolves(),
        getPendingHubPushes: sinon.stub().resolves([]),
        recordHubPushAttempt: sinon.stub().resolves(),
        markHubPushDelivered: sinon.stub().resolves()
    };
    return {
        selector,
        indexer: { hubClient, indexerDb, hubSelector: selector },
        deliveries,
        advanceCalls: () => advanceCalls
    };
}

describe('HubPushQueue selector retries', function(){
    afterEach(function(){ sinon.restore(); });

    it('does not move the selector after a push connection error', async function(){
        let fixture = makeFixture();
        let queue = new HubPushQueue(fixture.indexer);

        await queue.attempt(makeRow({ id: 201, attempts: 3 }));

        assert.strictEqual(fixture.selector.current(), 'http://hub-a.test');
        assert.strictEqual(fixture.advanceCalls(), 0);
        assert.strictEqual(fixture.indexer.indexerDb.poolQuery.callCount, 0);
        assert.strictEqual(fixture.indexer.indexerDb.recordHubPushAttempt.calledOnce, true);
    });

    it('clears old-hub backoff before fetching due rows after a move', async function(){
        let fixture = makeFixture();
        let queue = new HubPushQueue(fixture.indexer);

        fixture.selector.advance();
        await queue.drain();

        assert.strictEqual(fixture.indexer.indexerDb.poolQuery.calledOnce, true);
        assert.strictEqual(fixture.indexer.indexerDb.getPendingHubPushes.calledOnce, true);
        assert.strictEqual(fixture.indexer.indexerDb.poolQuery.calledBefore(
            fixture.indexer.indexerDb.getPendingHubPushes), true);
    });

    it('delivers an undelivered row to the current hub and resets its attempts after a move', async function(){
        let fixture = makeFixture();
        let queue = new HubPushQueue(fixture.indexer);
        let row = makeRow({ id: 202, attempts: 7,
            last_attempted_at: '2026-10-03T00:00:00.000Z', last_error: 'hub down' });

        await queue.attempt(row);
        fixture.selector.advance();
        await queue.attempt(row);

        assert.deepStrictEqual(fixture.deliveries,
            ['http://hub-a.test', 'http://hub-b.test']);
        assert.strictEqual(row.attempts, 0);
        assert.strictEqual(row.last_attempted_at, null);
        assert.strictEqual(row.last_error, null);
        assert.strictEqual(fixture.indexer.indexerDb.poolQuery.calledOnce, true);
        assert.match(fixture.indexer.indexerDb.poolQuery.firstCall.args[0],
            /SET attempts = 0, last_attempted_at = NULL/);
        assert.strictEqual(fixture.indexer.indexerDb.markHubPushDelivered.calledWith(202), true);
    });
});

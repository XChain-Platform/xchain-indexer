// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert       = require('assert');
const http         = require('http');
const sinon        = require('sinon');
const HubClient    = require('../../../../src/hub/hub_client.js');
const HubPushQueue = require('../../../../src/hub/hub_push_queue.js');

function startHub(response){
    return new Promise((resolve) => {
        let server = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                res.writeHead(response.status, response.headers || { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response.body));
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({
            server,
            url: 'http://127.0.0.1:' + server.address().port + '/'
        }));
    });
}

let hub = null;

describe('HubClient push acknowledgements', function(){
    afterEach(function(done){
        sinon.restore();
        if(!hub) return done();
        let closing = hub; hub = null;
        closing.server.closeAllConnections && closing.server.closeAllConnections();
        closing.server.close(() => done());
    });

    it('keeps a durable row after a JSON HTTP 503 without an RPC envelope', async function(){
        hub = await startHub({ status: 503, body: { message: 'temporarily unavailable' } });
        let hubClient = new HubClient(hub.url, '');
        let indexerDb = {
            recordHubPushAttempt: sinon.stub().resolves(),
            markHubPushDelivered: sinon.stub().resolves()
        };
        let queue = new HubPushQueue({ hubClient, indexerDb });
        let row = { id: 7, push_type: 'price_batch', attempts: 0,
                    payload: JSON.stringify({ source_chain: 'BTC', rounds: [] }) };

        assert.strictEqual(await queue.attempt(row), false);
        assert.strictEqual(indexerDb.markHubPushDelivered.callCount, 0);
        assert.strictEqual(indexerDb.recordHubPushAttempt.callCount, 1);
        assert.match(indexerDb.recordHubPushAttempt.firstCall.args[1],
            /HTTP 503 without a JSON-RPC envelope/);
    });

    it('rejects a successful HTTP response with no result member', async function(){
        hub = await startHub({ status: 200, body: { jsonrpc: '2.0', id: 1 } });
        let client = new HubClient(hub.url, '');
        await assert.rejects(() => client.pushPriceBatch({}), (err) => {
            assert.strictEqual(err.httpStatus, 200);
            assert.strictEqual(err.rpcCode, undefined);
            return /neither result nor error/.test(err.message);
        });
    });

    it('rejects a null result as no push acknowledgement', async function(){
        hub = await startHub({ status: 200, body: { jsonrpc: '2.0', id: 1, result: null } });
        let client = new HubClient(hub.url, '');
        await assert.rejects(() => client.pushPriceBatch({}), (err) => {
            assert.strictEqual(err.hubRejection, 'no acknowledgement');
            return /no acknowledgement for pushpricebatch/.test(err.message);
        });
    });

    it('classifies an envelope-less JSON HTTP 429 as rate limited', async function(){
        hub = await startHub({
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '7' },
            body: { message: 'slow down' }
        });
        let client = new HubClient(hub.url, '');
        await assert.rejects(() => client.pushPriceBatch({}), (err) => {
            assert.strictEqual(err.rateLimited, true);
            assert.strictEqual(err.retryAfterMs, 7000);
            return true;
        });
    });

    it('still accepts an object acknowledgement', async function(){
        hub = await startHub({
            status: 200,
            body: { jsonrpc: '2.0', id: 1, result: { accepted: true } }
        });
        let client = new HubClient(hub.url, '');
        assert.deepStrictEqual(await client.pushPriceBatch({}), { accepted: true });
    });
});

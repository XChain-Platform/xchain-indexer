// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Hub 429 handling on the price-push rails.
//
// The measured failure, driving a chain-only node's price-history recovery on
// 2026-08-27: the hub's per-IP guard answered `pushpricebatch` with
// express-rate-limit's default text/html body, and HubClient._call reported that
// as `Invalid JSON response: Unexpected token 'T'`. Two things were wrong at
// once. The message named neither the throttle nor the limit, so the failure was
// opaque; and the queue treated the rejection as a delivery attempt, charging
// exponential backoff (and, for the capped `price_round` type, walking the row
// toward 'failed') against a payload the hub had never even looked at.
//
// The client half is driven through a REAL http server rather than a stubbed
// http.request, because the defect lived in the response shape on the wire: a
// stub that returns a body string and no statusCode reproduces neither the
// legacy plain-text 429 nor the header-derived limit.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert       = require('assert');
const sinon        = require('sinon');
const http         = require('http');
const HubClient    = require('../../src/hub_client.js');
const HubPushQueue = require('../../src/hub_push_queue.js');

// A hub stand-in that answers whatever the current test asks for.
function startHub(handler){
    return new Promise((resolve) => {
        let server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => handler(JSON.parse(body || '{}'), res));
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, url: 'http://127.0.0.1:' + server.address().port + '/' });
        });
    });
}

describe('hub rate-limit handling on the price-push rails', function(){

    describe('HubClient._call against a throttling hub', function(){
        let hub = null;

        afterEach(function(done){
            if(!hub) return done();
            hub.server.close(() => { hub = null; done(); });
        });

        it('turns the hub\'s JSON-RPC 429 into a typed error naming the limit and the wait', async function(){
            hub = await startHub((req, res) => {
                res.setHeader('Retry-After', '60');
                res.setHeader('RateLimit-Limit', '100');
                res.status = 429;
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0', id: req.id,
                    error: {
                        code: -32029,
                        message: 'hub rate limit exceeded: 100 requests per 60s per IP (HUB_RATE_LIMIT_RPM); retry after 60s',
                        data: { limit: 100, windowMs: 60000, retryAfterSeconds: 60, policy: 'per-ip', env: 'HUB_RATE_LIMIT_RPM' }
                    }
                }));
            });

            let client = new HubClient(hub.url, '');
            let err = await client.pushPriceBatch({ source_chain: 'BTC', rounds: [] }).then(
                () => null, (e) => e);

            assert.ok(err, 'a throttled push must reject');
            assert.strictEqual(err.rateLimited, true);
            assert.strictEqual(err.httpStatus, 429);
            assert.strictEqual(err.rpcCode, -32029);
            assert.strictEqual(err.hubRateLimit, 100);
            assert.strictEqual(err.retryAfterMs, 60000);
            assert.ok(/rate limit exceeded/.test(err.message), err.message);
            assert.ok(/100 requests per 60s/.test(err.message), err.message);
            assert.ok(/HUB_RATE_LIMIT_RPM/.test(err.message), err.message);
        });

        // A node can be pointed at a hub that predates this change, and the
        // RateLimit-* headers are still there to read even when the body is not JSON.
        it('names the limit from the headers when a legacy hub sends a plain-text 429', async function(){
            hub = await startHub((req, res) => {
                res.writeHead(429, {
                    'Content-Type':  'text/html; charset=utf-8',
                    'Retry-After':   '37',
                    'RateLimit-Limit': '100'
                });
                res.end('Too many requests, please try again later.');
            });

            let client = new HubClient(hub.url, '');
            let err = await client.pushPriceBatch({ source_chain: 'BTC', rounds: [] }).then(
                () => null, (e) => e);

            assert.ok(err);
            assert.strictEqual(err.rateLimited, true);
            assert.strictEqual(err.httpStatus, 429);
            assert.strictEqual(err.hubRateLimit, 100);
            assert.strictEqual(err.retryAfterMs, 37000);
            assert.ok(/rate limit exceeded/.test(err.message), err.message);
            assert.ok(/100 req\/min/.test(err.message), err.message);
            // The message this replaces, and the reason the drill was opaque.
            assert.ok(!/Invalid JSON response/.test(err.message), err.message);
        });

        it('defaults the wait to a full window when the hub advertises none', async function(){
            hub = await startHub((req, res) => {
                res.writeHead(429, { 'Content-Type': 'text/plain' });
                res.end('slow down');
            });
            let client = new HubClient(hub.url, '');
            let err = await client.pushPriceBatch({}).then(() => null, (e) => e);
            assert.strictEqual(err.rateLimited, true);
            assert.strictEqual(err.retryAfterMs, 60000);
            assert.ok(/limit not advertised/.test(err.message), err.message);
        });

        it('names the status on any other non-2xx with a non-JSON body', async function(){
            hub = await startHub((req, res) => {
                res.writeHead(502, { 'Content-Type': 'text/html' });
                res.end('<html>bad gateway</html>');
            });
            let client = new HubClient(hub.url, '');
            let err = await client.pushPriceBatch({}).then(() => null, (e) => e);
            assert.strictEqual(err.rateLimited, undefined);
            assert.strictEqual(err.httpStatus, 502);
            assert.ok(/HTTP 502/.test(err.message), err.message);
        });

        it('leaves an ordinary 200 JSON-RPC round trip exactly as it was', async function(){
            hub = await startHub((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { accepted: true } }));
            });
            let client = new HubClient(hub.url, '');
            let result = await client.pushPriceBatch({ source_chain: 'BTC', rounds: [] });
            assert.deepStrictEqual(result, { accepted: true });
        });

        it('still reports a malformed 200 body as an invalid JSON response', async function(){
            hub = await startHub((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{ not json');
            });
            let client = new HubClient(hub.url, '');
            let err = await client.pushPriceBatch({}).then(() => null, (e) => e);
            assert.ok(/Invalid JSON response/.test(err.message), err.message);
            assert.strictEqual(err.rateLimited, undefined);
        });
    });

    describe('HubPushQueue under a throttling hub', function(){

        afterEach(function(){ sinon.restore(); });

        function throttleError(retryAfterMs){
            let err = new Error('hub rate limit exceeded (100 req/min); retry after 60s [HTTP 429]');
            err.rateLimited  = true;
            err.httpStatus   = 429;
            err.hubRateLimit = 100;
            err.retryAfterMs = retryAfterMs;
            return err;
        }

        function makeQueue(pushBatchStub, rows){
            let hubClient = {
                enabled: true,
                pushPriceRound:  sinon.stub().resolves(),
                pushOraclePrice: sinon.stub().resolves(),
                pushPriceBatch:  pushBatchStub,
                retractPriceRange: sinon.stub().resolves(),
                retractXcallRange: sinon.stub().resolves(),
                retractMatchRange: sinon.stub().resolves()
            };
            let indexerDb = {
                getPendingHubPushes:  sinon.stub().resolves(rows),
                recordHubPushAttempt: sinon.stub().resolves(),
                markHubPushDelivered: sinon.stub().resolves()
            };
            let q = new HubPushQueue({ hubClient, indexerDb }, { failedRetentionSec: 0 });
            return { q, hubClient, indexerDb };
        }

        function batchRows(n){
            let rows = [];
            for(let i = 1; i <= n; i++){
                rows.push({ id: i, push_type: 'price_batch', payload: JSON.stringify({ rounds: [i] }),
                            attempts: 0, last_attempted_at: null });
            }
            return rows;
        }

        it('charges NO attempt for a throttled row: the hub never judged the payload', async function(){
            sinon.stub(console, 'warn');
            let { q, indexerDb } = makeQueue(sinon.stub().rejects(throttleError(60000)), batchRows(1));
            await q.drain();
            assert.strictEqual(indexerDb.recordHubPushAttempt.callCount, 0);
            assert.strictEqual(indexerDb.markHubPushDelivered.callCount, 0);
        });

        // Without this, one 429 was followed by the other 49 rows in the batch,
        // every one of them a guaranteed rejection charged as a delivery attempt.
        it('stops the batch at the first 429 instead of pushing the other 49 rows into it', async function(){
            sinon.stub(console, 'warn');
            let push = sinon.stub().rejects(throttleError(60000));
            let { q } = makeQueue(push, batchRows(50));
            await q.drain();
            assert.strictEqual(push.callCount, 1);
        });

        it('holds the whole queue for the advertised Retry-After, then drains again', async function(){
            sinon.stub(console, 'warn');
            let clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
            let push = sinon.stub().rejects(throttleError(30000));
            let { q, indexerDb } = makeQueue(push, batchRows(1));

            await q.drain();
            assert.strictEqual(push.callCount, 1);
            assert.strictEqual(q._throttledUntilMs, 1_030_000);

            // Inside the hold: no push, and no DB round trip either.
            clock.tick(29_000);
            await q.drain();
            assert.strictEqual(push.callCount, 1);
            assert.strictEqual(indexerDb.getPendingHubPushes.callCount, 1);

            // Past it: the row is still pending, still due, and goes out unchanged.
            clock.tick(2_000);
            push.resolves();
            await q.drain();
            assert.strictEqual(push.callCount, 2);
            assert.strictEqual(indexerDb.markHubPushDelivered.callCount, 1);
        });

        it('falls back to a one-minute hold when the throttle advertises no wait', async function(){
            sinon.stub(console, 'warn');
            let clock = sinon.useFakeTimers({ now: 5_000_000, toFake: ['Date'] });
            let { q } = makeQueue(sinon.stub().rejects(throttleError(undefined)), batchRows(1));
            await q.drain();
            assert.strictEqual(q._throttledUntilMs, 5_060_000);
            clock.tick(0);
        });

        // The capped type is the one a mis-classified 429 could actually destroy: ten
        // throttled ticks read as delivery attempts would retire a re-derivable round to
        // 'failed' for a reason that had nothing to do with the row.
        it('does not walk a capped price_round row toward failed on a throttle', async function(){
            sinon.stub(console, 'warn');
            let hubClient = {
                enabled: true,
                pushPriceRound:  sinon.stub().rejects(throttleError(60000)),
                pushOraclePrice: sinon.stub().resolves(),
                pushPriceBatch:  sinon.stub().resolves()
            };
            let indexerDb = {
                getPendingHubPushes:  sinon.stub().resolves([{ id: 7, push_type: 'price_round',
                    payload: JSON.stringify({ round: 5 }), attempts: 9, last_attempted_at: null }]),
                recordHubPushAttempt: sinon.stub().resolves(),
                markHubPushDelivered: sinon.stub().resolves()
            };
            let q = new HubPushQueue({ hubClient, indexerDb }, { failedRetentionSec: 0, maxAttempts: 10 });
            await q.drain();
            assert.strictEqual(indexerDb.recordHubPushAttempt.callCount, 0);
        });

        it('still records the attempt for an ordinary (non-throttle) failure', async function(){
            sinon.stub(console, 'warn');
            let { q, indexerDb } = makeQueue(sinon.stub().rejects(new Error('hub down')), batchRows(1));
            await q.drain();
            assert.strictEqual(indexerDb.recordHubPushAttempt.callCount, 1);
            assert.strictEqual(q._throttledUntilMs, 0);
        });
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// HubClient._call must always settle, and the push queue must survive a hub that
// dies mid-response.
//
// The measured failure: a hub that sends its headers and part of a body and then
// drops the connection aborts the RESPONSE, not the request, so `req.on('error')`
// never fires and `res.on('end')` never fires. _call carried handlers for neither,
// so the promise stayed pending forever - a probe against the pre-fix client sat
// PENDING past 12s, twelve times the 5000ms socket timeout, because that option is
// an IDLE-socket timer and cannot fire on a socket that is already gone.
// HubPushQueue.drain() awaits _attempt() with `draining` latched, so the queue then
// returned at `if(this.draining) return` on every later tick: the push queue stopped
// permanently, with rows neither acknowledged nor retried.
//
// Driven through a REAL loopback server, not a stubbed http.request, because the
// defect IS the wire lifecycle: a stub that emits 'data' then 'end' cannot express
// a body that never completes.

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

// Resolve to 'pending' when the call has not settled inside ms. Distinguishes the
// defect (never settles) from every ordinary rejection.
//
// The timer here is a bound, not a settle: it loses the race on every green run,
// and its expiry is the failure the assertions below reject. Do not sweep it into
// waitUntil() - the race returns the rejection VALUE that those assertions match
// on, which a boolean poll cannot carry.
function settledWithin(promise, ms){
    let outcome = promise.then(() => 'resolved', (e) => e);
    return Promise.race([outcome, new Promise((r) => setTimeout(() => r('pending'), ms))]);
}

describe('HubClient response-lifecycle settling', function(){

    let hub = null;

    afterEach(function(done){
        sinon.restore();
        if(!hub) return done();
        let h = hub; hub = null;
        h.server.closeAllConnections && h.server.closeAllConnections();
        h.server.close(() => done());
    });

    it('rejects when the hub truncates the response body instead of hanging forever', async function(){
        hub = await startHub((req, res) => {
            // Content-Length promises 500 bytes; the socket dies after ~36 of them.
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' });
            res.write('{"jsonrpc":"2.0","result":{"partial":');
            // Deliberate delay: holds the socket open long enough for the client to
            // reach the mid-BODY state, which is the state under test.
            setTimeout(() => res.socket.destroy(), 20);
        });
        let c = new HubClient(hub.url, '');
        let outcome = await settledWithin(c._call('ping', {}), 3000);
        assert.notStrictEqual(outcome, 'pending', 'the truncated response left _call pending');
        assert.notStrictEqual(outcome, 'resolved', 'a truncated body must not read as a result');
        assert.match(outcome.message, /before the body was complete|hub response error/);
    });

    it('rejects at the wall-clock deadline when the hub drip-feeds the body', async function(){
        let ticker = null;
        hub = await startHub((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '5000' });
            // One byte every 100ms resets the idle-socket timer forever, so only a
            // total-request ceiling can end this call.
            ticker = setInterval(() => { try { res.write('x'); } catch(e){ clearInterval(ticker); } }, 100);
            res.on('close', () => clearInterval(ticker));
        });
        let c = new HubClient(hub.url, '');
        c.callDeadlineMs = 800;
        let outcome = await settledWithin(c._call('ping', {}), 4000);
        clearInterval(ticker);
        assert.notStrictEqual(outcome, 'pending', 'a drip-fed body outlived the deadline');
        assert.match(outcome.message, /exceeded its 800ms deadline/);
    });

    it('still resolves a healthy response', async function(){
        hub = await startHub((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
        });
        let c = new HubClient(hub.url, '');
        assert.deepStrictEqual(await c._call('ping', {}), { ok: true });
    });

    it('leaves the push queue drainable after a truncated hub response', async function(){
        sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
        hub = await startHub((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' });
            res.write('{"jsonrpc":"2.0","result":{"partial":');
            // Deliberate delay, same reason as the truncation case above.
            setTimeout(() => res.socket.destroy(), 20);
        });
        let hubClient = new HubClient(hub.url, '');
        let rows = [{ id: 1, push_type: 'price_batch', payload: JSON.stringify({ rounds: [1] }),
                      attempts: 0, last_attempted_at: null }];
        let indexerDb = {
            getPendingHubPushes:  sinon.stub().resolves(rows),
            recordHubPushAttempt: sinon.stub().resolves(),
            markHubPushDelivered: sinon.stub().resolves()
        };
        let q = new HubPushQueue({ hubClient, indexerDb }, { failedRetentionSec: 0 });

        await settledWithin(q.drain(), 3000);
        assert.strictEqual(q.draining, false, 'drain latched `draining` across an unsettled call');
        assert.strictEqual(indexerDb.recordHubPushAttempt.callCount, 1,
            'the failed push was never charged an attempt, so it can never retry');

        // The latch is what stops every later tick; prove a second drain still works.
        await settledWithin(q.drain(), 3000);
        assert.strictEqual(indexerDb.getPendingHubPushes.callCount, 2,
            'the second drain returned at the overlap guard instead of fetching rows');
    });
});

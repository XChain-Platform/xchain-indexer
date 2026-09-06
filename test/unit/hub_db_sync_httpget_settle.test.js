// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// HubDbSync._httpGet must always settle, so mirror bootstrap can release its guard.
//
// The measured failure: a hub restarting in the middle of a snapshot body aborts the
// RESPONSE, not the request, so `req.on('error')` never fires and `res.on('end')`
// never fires. _httpGet carried handlers for neither, and a probe against the
// pre-fix client sat PENDING past 40s - beyond the 30000ms socket option, which is an
// IDLE-socket timer and cannot fire on a socket that is already gone. _bootstrapAll
// awaits that request with `_bootstrapping` latched and clears the flag only in its
// `finally`, so every later reconnect and poll returned at `if (this._bootstrapping)
// return`: the mirror bootstrap, and the settlement barriers it feeds, stalled until
// the process restarted.
//
// Driven through a REAL loopback server, not a stubbed http.request, because the
// defect IS the wire lifecycle: a stub that emits 'data' then 'end' cannot express a
// body that never completes.

const assert    = require('assert');
const http      = require('http');
const HubDbSync = require('../../src/hub_db_sync.js');

function startHub(handler){
    return new Promise((resolve) => {
        let server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, url: 'http://127.0.0.1:' + server.address().port });
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

// A hub that sends headers promising a body, part of it, then drops the socket.
//
// The 20ms is a deliberate delay, not a settle: it holds the socket open long
// enough for the client to reach the mid-BODY state, which is the state under
// test. Killing at flush time instead races the client into the request-error
// branch, and the disjunctive assertion below would swallow the difference.
function truncatingHub(req, res){
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '9000' });
    res.write('{"rows":[{"id":1,');
    setTimeout(() => res.socket.destroy(), 20);
}

function makeSync(hubUrl){
    return new HubDbSync({ doQuery: async () => [{ h: 0, ts: 0 }] }, { hubUrl });
}

describe('HubDbSync snapshot-request settling', function(){

    let hub = null;

    afterEach(function(done){
        if(!hub) return done();
        let h = hub; hub = null;
        h.server.closeAllConnections && h.server.closeAllConnections();
        h.server.close(() => done());
    });

    it('rejects a truncated snapshot body instead of hanging forever', async function(){
        hub = await startHub(truncatingHub);
        let outcome = await settledWithin(makeSync(hub.url)._httpGet('/hub-db/snapshot/oracle_prices'), 3000);
        assert.notStrictEqual(outcome, 'pending', 'the truncated snapshot left _httpGet pending');
        assert.notStrictEqual(outcome, 'resolved', 'a truncated body must not read as a snapshot page');
        assert.match(outcome.message, /before the body was complete|hub response error/);
    });

    it('rejects at the wall-clock deadline when the hub drip-feeds the body', async function(){
        let ticker = null;
        hub = await startHub((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '9000' });
            // One byte every 100ms resets the idle-socket timer forever, so only a
            // total-request ceiling can end this call.
            ticker = setInterval(() => { try { res.write('x'); } catch(e){ clearInterval(ticker); } }, 100);
            res.on('close', () => clearInterval(ticker));
        });
        let sync = makeSync(hub.url);
        sync.httpDeadlineMs = 800;
        let outcome = await settledWithin(sync._httpGet('/hub-db/snapshot/oracle_prices'), 4000);
        clearInterval(ticker);
        assert.notStrictEqual(outcome, 'pending', 'a drip-fed body outlived the deadline');
        assert.match(outcome.message, /exceeded its 800ms deadline/);
    });

    it('still resolves a healthy snapshot page', async function(){
        hub = await startHub((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ rows: [], schema_version: null }));
        });
        assert.deepStrictEqual(await makeSync(hub.url)._httpGet('/hub-db/snapshot/oracle_prices'),
            { rows: [], schema_version: null });
    });

    it('releases the _bootstrapping guard after a truncated snapshot response', async function(){
        hub = await startHub(truncatingHub);
        let sync = makeSync(hub.url);
        // Every table's fetch goes through the real transport; the per-table try/catch
        // in _bootstrapAll turns each rejection into "not drained". `running` is false,
        // so no retry timer is armed and the flag is the only thing under test.
        sync._bootstrapTable = () => sync._httpGet('/hub-db/snapshot/oracle_prices');
        let warn = console.warn;
        console.warn = () => {};
        try {
            await settledWithin(sync._bootstrapAll(), 5000);
        } finally {
            console.warn = warn;
        }
        assert.strictEqual(sync._bootstrapping, false,
            '_bootstrapAll latched _bootstrapping across an unsettled snapshot request');
    });
});

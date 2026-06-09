// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-landscape terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert    = require('assert');
const sinon     = require('sinon');
const http      = require('http');
const https     = require('https');
const EventEmitter = require('events');
const HubClient = require('../../src/hub_client.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake http(s).request stub that invokes the response callback with a
 * simulated IncomingMessage, then drives 'data'+'end' events to deliver the body.
 *
 * Returns { stub, fakeReq } so tests can inspect calls and emit errors.
 */
function buildHttpStub(responseBody){
    let fakeReq = new EventEmitter();
    fakeReq.write = sinon.stub();
    fakeReq.end   = sinon.stub();
    fakeReq.destroy = sinon.stub().callsFake(function(err){ fakeReq.emit('error', err); });

    let stub = sinon.stub().callsFake(function(opts, cb){
        // Schedule the response asynchronously to let req.write/end fire first
        setImmediate(() => {
            let fakeRes = new EventEmitter();
            cb(fakeRes);
            setImmediate(() => {
                fakeRes.emit('data', responseBody);
                fakeRes.emit('end');
            });
        });
        return fakeReq;
    });
    return { stub, fakeReq };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HubClient', function(){

    afterEach(function(){
        sinon.restore();
        // Remove env vars that could bleed between tests
        delete process.env.HUB_API_URL;
        delete process.env.HUB_API_KEY;
    });

    // -----------------------------------------------------------------------
    // constructor
    // -----------------------------------------------------------------------
    describe('constructor', function(){
        it('uses provided hubUrl and marks enabled=true', function(){
            let c = new HubClient('http://hub.example.com', 'key1');
            assert.strictEqual(c.enabled, true);
            assert.strictEqual(c.hubUrl, 'http://hub.example.com');
            assert.strictEqual(c.apiKey, 'key1');
        });

        it('falls back to env vars when constructor args missing', function(){
            process.env.HUB_API_URL = 'http://env-hub.example.com';
            process.env.HUB_API_KEY = 'envkey';
            let c = new HubClient();
            assert.strictEqual(c.hubUrl, 'http://env-hub.example.com');
            assert.strictEqual(c.apiKey, 'envkey');
            assert.strictEqual(c.enabled, true);
        });

        it('marks enabled=false when no url is provided or in env', function(){
            let c = new HubClient('', '');
            assert.strictEqual(c.enabled, false);
        });

        it('marks enabled=false when url is empty string from env', function(){
            process.env.HUB_API_URL = '';
            let c = new HubClient();
            assert.strictEqual(c.enabled, false);
        });
    });

    // -----------------------------------------------------------------------
    // pushChainTip — public-method guard + _call stubbing
    // -----------------------------------------------------------------------
    describe('pushChainTip()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            await c.pushChainTip('BTC', 'mainnet', 800000, 1700000000);
            assert.strictEqual(callStub.callCount, 0);
        });

        it('calls _call with pushchaintip and correct payload', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            await c.pushChainTip('BTC', 'regtest', 100, 1700000000);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushchaintip');
            let payload = callStub.firstCall.args[1];
            assert.strictEqual(payload.coin, 'BTC');
            assert.strictEqual(payload.network, 'regtest');
            assert.strictEqual(payload.block_height, 100);
            assert.strictEqual(payload.block_time, 1700000000);
        });

        it('swallows (does not re-throw) a _call rejection', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(new Error('hub down'));
            // Must NOT throw
            await assert.doesNotReject(() => c.pushChainTip('BTC', 'mainnet', 1, 1));
        });
    });

    // -----------------------------------------------------------------------
    // pushPriceRound
    // -----------------------------------------------------------------------
    describe('pushPriceRound()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            let result = await c.pushPriceRound({ round: 1 });
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushpriceround and passes roundData', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, '_call').resolves({ ok: true });
            let roundData = { round: 5, coin: 'BTC', price: '64000' };
            let result = await c.pushPriceRound(roundData);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushpriceround');
            assert.strictEqual(callStub.firstCall.args[1], roundData);
            assert.deepStrictEqual(result, { ok: true });
        });

        it('propagates rejection from _call (not swallowed)', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(new Error('rpc error'));
            await assert.rejects(() => c.pushPriceRound({}), /rpc error/);
        });
    });

    // -----------------------------------------------------------------------
    // pushOraclePrice
    // -----------------------------------------------------------------------
    describe('pushOraclePrice()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            let result = await c.pushOraclePrice({ price: '100' });
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushoracleprice and passes priceData', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, '_call').resolves({ ok: true });
            let priceData = { tick: 'AAA', price: '1.50' };
            let result = await c.pushOraclePrice(priceData);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushoracleprice');
            assert.strictEqual(callStub.firstCall.args[1], priceData);
            assert.deepStrictEqual(result, { ok: true });
        });

        it('propagates rejection from _call', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(new Error('oracle rpc error'));
            await assert.rejects(() => c.pushOraclePrice({}), /oracle rpc error/);
        });
    });

    // -----------------------------------------------------------------------
    // retractPriceRange
    // -----------------------------------------------------------------------
    describe('retractPriceRange()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            let result = await c.retractPriceRange('BTC', 42);
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushpricereorg and correct payload', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            await c.retractPriceRange('LTC', 999);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushpricereorg');
            let payload = callStub.firstCall.args[1];
            assert.strictEqual(payload.source_chain, 'LTC');
            assert.strictEqual(payload.from_action_index, 999);
        });

        it('propagates rejection from _call', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(new Error('reorg error'));
            await assert.rejects(() => c.retractPriceRange('BTC', 1), /reorg error/);
        });
    });

    // -----------------------------------------------------------------------
    // _call internals — http.request mocking
    //
    // These tests drive the raw socket path via a fake http.request that
    // returns an EventEmitter-shaped fake request and fires fake response events.
    // -----------------------------------------------------------------------
    describe('_call() HTTP internals', function(){
        it('resolves with parsed result from a successful http response', async function(){
            let c = new HubClient('http://hub.example.com:3003', 'mykey');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: { status: 'ok' }
            }));
            sinon.stub(http, 'request').callsFake(stub);

            let result = await c._call('testmethod', { foo: 'bar' });
            assert.deepStrictEqual(result, { status: 'ok' });
        });

        it('uses https.request for https:// URLs', async function(){
            let c = new HubClient('https://secure-hub.example.com', 'mykey');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: { ok: true }
            }));
            let httpsStub = sinon.stub(https, 'request').callsFake(stub);

            let result = await c._call('ping', {});
            assert.strictEqual(httpsStub.calledOnce, true);
            assert.deepStrictEqual(result, { ok: true });
        });

        it('sends the API key as x-api-key header when apiKey is set', async function(){
            let c = new HubClient('http://hub.example.com', 'supersecret');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: {}
            }));
            sinon.stub(http, 'request').callsFake(stub);

            await c._call('ping', {});
            let opts = stub.firstCall.args[0];
            assert.strictEqual(opts.headers['x-api-key'], 'supersecret');
        });

        it('does NOT set x-api-key header when apiKey is empty', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: {}
            }));
            sinon.stub(http, 'request').callsFake(stub);

            await c._call('ping', {});
            let opts = stub.firstCall.args[0];
            assert.strictEqual(opts.headers['x-api-key'], undefined);
        });

        it('rejects when response contains an error field', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' }
            }));
            sinon.stub(http, 'request').callsFake(stub);

            await assert.rejects(() => c._call('ping', {}), /Invalid Request/);
        });

        it('rejects with JSON parse error when response body is not valid JSON', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let { stub } = buildHttpStub('not-json-at-all');
            sinon.stub(http, 'request').callsFake(stub);

            await assert.rejects(() => c._call('ping', {}), /Invalid JSON response/);
        });

        it('rejects when req emits an error event', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let fakeReq = new EventEmitter();
            fakeReq.write   = sinon.stub();
            fakeReq.end     = sinon.stub();
            fakeReq.destroy = sinon.stub();

            sinon.stub(http, 'request').callsFake(function(opts, cb){
                setImmediate(() => fakeReq.emit('error', new Error('ECONNREFUSED')));
                return fakeReq;
            });

            await assert.rejects(() => c._call('ping', {}), /ECONNREFUSED/);
        });

        it('calls req.write with the serialized JSON body', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let { stub, fakeReq } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: {}
            }));
            sinon.stub(http, 'request').callsFake(stub);

            await c._call('myMethod', { a: 1 });
            assert.strictEqual(fakeReq.write.calledOnce, true);
            let written = JSON.parse(fakeReq.write.firstCall.args[0]);
            assert.strictEqual(written.method, 'myMethod');
            assert.deepStrictEqual(written.params, { a: 1 });
            assert.strictEqual(written.jsonrpc, '2.0');
        });

        it('uses port 80 by default for http', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let { stub } = buildHttpStub(JSON.stringify({ jsonrpc:'2.0', id:1, result:{} }));
            sinon.stub(http, 'request').callsFake(stub);

            await c._call('ping', {});
            let opts = stub.firstCall.args[0];
            assert.strictEqual(opts.port, 80);
        });

        it('uses port 443 by default for https', async function(){
            let c = new HubClient('https://hub.example.com', '');
            let { stub } = buildHttpStub(JSON.stringify({ jsonrpc:'2.0', id:1, result:{} }));
            sinon.stub(https, 'request').callsFake(stub);

            await c._call('ping', {});
            let opts = stub.firstCall.args[0];
            assert.strictEqual(opts.port, 443);
        });

        it('timeout event destroys the request', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let fakeReq = new EventEmitter();
            fakeReq.write   = sinon.stub();
            fakeReq.end     = sinon.stub();
            // destroy should propagate an error so the promise rejects
            fakeReq.destroy = sinon.stub().callsFake(function(err){
                fakeReq.emit('error', err);
            });

            sinon.stub(http, 'request').callsFake(function(opts, cb){
                setImmediate(() => fakeReq.emit('timeout'));
                return fakeReq;
            });

            await assert.rejects(() => c._call('ping', {}), /Request timeout/);
            assert.strictEqual(fakeReq.destroy.calledOnce, true);
            let destroyArg = fakeReq.destroy.firstCall.args[0];
            assert.match(destroyArg.message, /Request timeout/);
        });
    });
});

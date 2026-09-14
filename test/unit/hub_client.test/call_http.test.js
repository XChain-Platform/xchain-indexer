// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// HubClient call(): the raw JSON-RPC request over a fake http(s).request,
// covering transport choice, headers, the written body, default ports, and
// how error envelopes, bad JSON, socket errors and timeouts reject.
// Part of the HubClient suite; see ../hub_client.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert    = require('assert');
const sinon     = require('sinon');
const http      = require('http');
const https     = require('https');
const EventEmitter = require('events');
const HubClient = require('../../../src/hub/hub_client.js');
const { buildHttpStub, restoreStubsAndHubEnv } = require('./helpers/hub_client_fixtures.js');

// -----------------------------------------------------------------------
// call internals: http.request mocking
//
// These tests drive the raw socket path via a fake http.request that
// returns an EventEmitter-shaped fake request and fires fake response events.
// -----------------------------------------------------------------------
describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('_call() HTTP internals', function(){
        it('resolves with parsed result from a successful http response', async function(){
            let c = new HubClient('http://hub.example.com:3003', 'mykey');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: { status: 'ok' }
            }));
            sinon.stub(http, 'request').callsFake(stub);

            let result = await c.call('testmethod', { foo: 'bar' });
            assert.deepStrictEqual(result, { status: 'ok' });
        });

        it('uses https.request for https:// URLs', async function(){
            let c = new HubClient('https://secure-hub.example.com', 'mykey');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: { ok: true }
            }));
            let httpsStub = sinon.stub(https, 'request').callsFake(stub);

            let result = await c.call('ping', {});
            assert.strictEqual(httpsStub.calledOnce, true);
            assert.deepStrictEqual(result, { ok: true });
        });
    });
});

describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('_call() HTTP internals', function(){
        it('sends the API key as x-api-key header when apiKey is set', async function(){
            let c = new HubClient('http://hub.example.com', 'supersecret');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: {}
            }));
            sinon.stub(http, 'request').callsFake(stub);

            await c.call('ping', {});
            let opts = stub.firstCall.args[0];
            assert.strictEqual(opts.headers['x-api-key'], 'supersecret');
        });

        it('does NOT set x-api-key header when apiKey is empty', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: {}
            }));
            sinon.stub(http, 'request').callsFake(stub);

            await c.call('ping', {});
            let opts = stub.firstCall.args[0];
            assert.strictEqual(opts.headers['x-api-key'], undefined);
        });

        it('rejects when response contains an error field', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' }
            }));
            sinon.stub(http, 'request').callsFake(stub);

            await assert.rejects(() => c.call('ping', {}), /Invalid Request/);
        });
    });
});

describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('_call() HTTP internals', function(){
        it('rejects with JSON parse error when response body is not valid JSON', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let { stub } = buildHttpStub('not-json-at-all');
            sinon.stub(http, 'request').callsFake(stub);

            await assert.rejects(() => c.call('ping', {}), /Invalid JSON response/);
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

            await assert.rejects(() => c.call('ping', {}), /ECONNREFUSED/);
        });

        it('calls req.write with the serialized JSON body', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let { stub, fakeReq } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: {}
            }));
            sinon.stub(http, 'request').callsFake(stub);

            await c.call('myMethod', { a: 1 });
            assert.strictEqual(fakeReq.write.calledOnce, true);
            let written = JSON.parse(fakeReq.write.firstCall.args[0]);
            assert.strictEqual(written.method, 'myMethod');
            assert.deepStrictEqual(written.params, { a: 1 });
            assert.strictEqual(written.jsonrpc, '2.0');
        });
    });
});

describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('_call() HTTP internals', function(){
        it('uses port 80 by default for http', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let { stub } = buildHttpStub(JSON.stringify({ jsonrpc:'2.0', id:1, result:{} }));
            sinon.stub(http, 'request').callsFake(stub);

            await c.call('ping', {});
            let opts = stub.firstCall.args[0];
            assert.strictEqual(opts.port, 80);
        });

        it('uses port 443 by default for https', async function(){
            let c = new HubClient('https://hub.example.com', '');
            let { stub } = buildHttpStub(JSON.stringify({ jsonrpc:'2.0', id:1, result:{} }));
            sinon.stub(https, 'request').callsFake(stub);

            await c.call('ping', {});
            let opts = stub.firstCall.args[0];
            assert.strictEqual(opts.port, 443);
        });
    });
});

describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('_call() HTTP internals', function(){
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

            await assert.rejects(() => c.call('ping', {}), /Request timeout/);
            assert.strictEqual(fakeReq.destroy.calledOnce, true);
            let destroyArg = fakeReq.destroy.firstCall.args[0];
            assert.match(destroyArg.message, /Request timeout/);
        });
    });
});

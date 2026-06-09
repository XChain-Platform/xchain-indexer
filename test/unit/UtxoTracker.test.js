// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert      = require('assert');
const sinon       = require('sinon');
const UtxoTracker = require('../../src/UtxoTracker.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake fetch that resolves with the given JSON body. */
function makeFetch(body, opts){
    opts = opts || {};
    return sinon.stub().resolves({
        ok:   opts.ok !== undefined ? opts.ok : true,
        status: opts.status || 200,
        json: async () => body
    });
}

describe('UtxoTracker', function(){

    let origFetch;

    beforeEach(function(){
        // Capture whatever global.fetch is before each test
        origFetch = global.fetch;
    });

    afterEach(function(){
        // Always restore
        global.fetch = origFetch;
        sinon.restore();
    });

    // -----------------------------------------------------------------------
    // constructor
    // -----------------------------------------------------------------------
    describe('constructor', function(){
        it('marks enabled=true and builds endpoint when url+port provided', function(){
            let t = new UtxoTracker('localhost', 3005);
            assert.strictEqual(t.enabled, true);
            assert.strictEqual(t.endpoint, 'http://localhost:3005');
            assert.strictEqual(t.url, 'localhost');
            assert.strictEqual(t.port, 3005);
        });

        it('marks enabled=false and endpoint=null when url missing', function(){
            let t = new UtxoTracker(null, 3005);
            assert.strictEqual(t.enabled, false);
            assert.strictEqual(t.endpoint, null);
        });

        it('marks enabled=false and endpoint=null when port missing', function(){
            let t = new UtxoTracker('localhost', null);
            assert.strictEqual(t.enabled, false);
            assert.strictEqual(t.endpoint, null);
        });

        it('marks enabled=false when both url and port missing', function(){
            let t = new UtxoTracker();
            assert.strictEqual(t.enabled, false);
            assert.strictEqual(t.endpoint, null);
        });

        it('marks enabled=false for empty string url', function(){
            let t = new UtxoTracker('', 3005);
            assert.strictEqual(t.enabled, false);
        });

        it('marks enabled=false for empty string port (falsy)', function(){
            let t = new UtxoTracker('localhost', '');
            assert.strictEqual(t.enabled, false);
        });
    });

    // -----------------------------------------------------------------------
    // _call
    // -----------------------------------------------------------------------
    describe('_call()', function(){
        it('throws when not enabled', async function(){
            let t = new UtxoTracker();
            await assert.rejects(
                () => t._call('get_first_seen', { address: 'abc' }),
                /UTXO tracker not configured/
            );
        });

        it('POSTs a well-formed JSON-RPC 2.0 body to endpoint', async function(){
            let t = new UtxoTracker('localhost', 3005);
            let stub = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: 100 } });
            global.fetch = stub;

            let result = await t._call('get_first_seen', { address: 'myaddr' });

            assert.strictEqual(stub.calledOnce, true);
            // First arg = endpoint
            assert.strictEqual(stub.firstCall.args[0], 'http://localhost:3005');
            // Method is POST
            assert.strictEqual(stub.firstCall.args[1].method, 'POST');
            // Content-Type header
            assert.strictEqual(stub.firstCall.args[1].headers['Content-Type'], 'application/json');
            // Body contains the right method + params
            let body = JSON.parse(stub.firstCall.args[1].body);
            assert.strictEqual(body.jsonrpc, '2.0');
            assert.strictEqual(body.method, 'get_first_seen');
            assert.deepStrictEqual(body.params, { address: 'myaddr' });
            assert.strictEqual(body.id, 1);
            // Return value is the result field
            assert.deepStrictEqual(result, { height: 100 });
        });

        it('throws on non-ok HTTP response', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({}, { ok: false, status: 500 });

            await assert.rejects(
                () => t._call('get_first_seen', {}),
                /UTXO tracker HTTP error: 500/
            );
        });

        it('throws when RPC response carries an error field', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({
                jsonrpc: '2.0', id: 1,
                error: { code: -32601, message: 'Method not found' }
            });

            await assert.rejects(
                () => t._call('unknown_method', {}),
                /UTXO tracker RPC error/
            );
        });

        it('propagates fetch network error (fetch rejects)', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = sinon.stub().rejects(new Error('ECONNREFUSED'));

            await assert.rejects(
                () => t._call('get_first_seen', {}),
                /ECONNREFUSED/
            );
        });

        it('returns result field from successful response', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: 42 } });

            let r = await t._call('get_first_seen', { address: 'x' });
            assert.deepStrictEqual(r, { height: 42 });
        });

        it('returns null result when RPC result is null', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: null });

            let r = await t._call('get_first_seen', { address: 'x' });
            assert.strictEqual(r, null);
        });
    });

    // -----------------------------------------------------------------------
    // getFirstSeen
    // -----------------------------------------------------------------------
    describe('getFirstSeen()', function(){
        it('returns { height: N } when RPC returns an object with a numeric height', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: 750000 } });

            let r = await t.getFirstSeen('1A1zP1...');
            assert.deepStrictEqual(r, { height: 750000 });
        });

        it('returns null when RPC result is null', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: null });

            let r = await t.getFirstSeen('unknown_address');
            assert.strictEqual(r, null);
        });

        it('returns null when RPC result is undefined (no result field in response)', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1 }); // result field absent → undefined

            let r = await t.getFirstSeen('unknown_address');
            assert.strictEqual(r, null);
        });

        it('returns null when result.height is not a number (string)', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: '100' } });

            let r = await t.getFirstSeen('1A1zP1...');
            assert.strictEqual(r, null);
        });

        it('returns null when result.height is missing', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: { other: 'field' } });

            let r = await t.getFirstSeen('1A1zP1...');
            assert.strictEqual(r, null);
        });

        it('passes the address correctly to _call', async function(){
            let t = new UtxoTracker('localhost', 3005);
            let stub = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: 1 } });
            global.fetch = stub;

            await t.getFirstSeen('bc1qtest');
            let body = JSON.parse(stub.firstCall.args[1].body);
            assert.strictEqual(body.method, 'get_first_seen');
            assert.deepStrictEqual(body.params, { address: 'bc1qtest' });
        });

        it('propagates errors from _call', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = sinon.stub().rejects(new Error('network down'));

            await assert.rejects(
                () => t.getFirstSeen('any'),
                /network down/
            );
        });

        it('returns height: 0 as a valid number (block 0)', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: 0 } });

            let r = await t.getFirstSeen('genesis');
            assert.deepStrictEqual(r, { height: 0 });
        });
    });
});

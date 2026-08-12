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
// test/unit/UtxoTracker.regression.test.js
//
// UtxoTracker is the oracle behind the DISPENSER fresh-address exception:
// getFirstSeen(address) answers "has this address ever appeared on chain?",
// and the DISPENSER action uses a null answer to grant the fresh-address
// exception against DISPENSER_PREFERENCE. That makes its return contract
// value-moving: the exact shape of a "fresh" answer (null) vs a "seen"
// answer ({height:N}) decides who is allowed to receive. These regression
// pins lock the answer shape so a codec/parsing drift can never quietly
// turn a seen address into a fresh one (or vice-versa) or make a malformed
// RPC reply throw where the action expects a clean null.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert      = require('assert');
const sinon       = require('sinon');
const UtxoTracker = require('../../src/UtxoTracker.js');

function makeFetch(body, opts){
    opts = opts || {};
    return sinon.stub().resolves({
        ok:     opts.ok !== undefined ? opts.ok : true,
        status: opts.status || 200,
        json:   async () => body
    });
}

describe('UtxoTracker DISPENSER fresh-address oracle @regression @tier1', function(){

    let origFetch;

    beforeEach(function(){ origFetch = global.fetch; });
    afterEach(function(){ global.fetch = origFetch; sinon.restore(); });

    describe('"seen" answer shape (grants no fresh-address exception)', function(){
        it('returns exactly { height: N } for a numeric height', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: 750000 } });
            let r = await t.getFirstSeen('1A1zP1...');
            assert.deepStrictEqual(r, { height: 750000 });
        });

        it('treats block 0 as a real sighting, NOT a fresh address', async function(){
            // A genesis-height sighting is falsy-adjacent (0); the oracle must still
            // report it as seen, or an address first seen at height 0 would wrongly
            // qualify for the fresh-address exception.
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: 0 } });
            let r = await t.getFirstSeen('genesis');
            assert.deepStrictEqual(r, { height: 0 });
        });
    });

    describe('"fresh" answer shape (grants the exception) — must be null, never a throw', function(){
        it('returns null when the address has never been seen (RPC result null)', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: null });
            assert.strictEqual(await t.getFirstSeen('never'), null);
        });

        it('returns null when the result field is absent (undefined)', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1 });
            assert.strictEqual(await t.getFirstSeen('never'), null);
        });

        it('rejects a non-numeric height as fresh (string height -> null), never coerces it', async function(){
            // The strict typeof-number guard is the pin: a stringly-typed height like
            // "100" must read as null (fresh), not silently coerce to a sighting.
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: '100' } });
            assert.strictEqual(await t.getFirstSeen('1A1zP1...'), null);
        });

        it('returns null when height is missing from the result object', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: { other: 'field' } });
            assert.strictEqual(await t.getFirstSeen('1A1zP1...'), null);
        });
    });

    describe('error surfaces stay distinguishable from a "fresh" answer', function(){
        it('an unconfigured tracker THROWS rather than answering fresh (null)', async function(){
            // Not-configured must never masquerade as "never seen": that would grant
            // the exception to every address on a mis-deployed node.
            let t = new UtxoTracker();
            await assert.rejects(() => t.getFirstSeen('x'), /UTXO tracker not configured/);
        });

        it('a non-ok HTTP response throws (not swallowed to null)', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({}, { ok: false, status: 500 });
            await assert.rejects(() => t.getFirstSeen('x'), /UTXO tracker HTTP error: 500/);
        });

        it('an RPC error field throws (not swallowed to null)', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } });
            await assert.rejects(() => t.getFirstSeen('x'), /UTXO tracker RPC error/);
        });

        it('a network failure propagates (not swallowed to null)', async function(){
            let t = new UtxoTracker('localhost', 3005);
            global.fetch = sinon.stub().rejects(new Error('ECONNREFUSED'));
            await assert.rejects(() => t.getFirstSeen('x'), /ECONNREFUSED/);
        });
    });

    describe('request wire-shape (a drift breaks the tracker contract silently)', function(){
        it('POSTs a JSON-RPC 2.0 get_first_seen with the address in params', async function(){
            let t = new UtxoTracker('localhost', 3005);
            let stub = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: 1 } });
            global.fetch = stub;
            await t.getFirstSeen('bc1qtest');
            assert.strictEqual(stub.firstCall.args[0], 'http://localhost:3005');
            assert.strictEqual(stub.firstCall.args[1].method, 'POST');
            let body = JSON.parse(stub.firstCall.args[1].body);
            assert.strictEqual(body.jsonrpc, '2.0');
            assert.strictEqual(body.method, 'get_first_seen');
            assert.deepStrictEqual(body.params, { address: 'bc1qtest' });
        });
    });
});

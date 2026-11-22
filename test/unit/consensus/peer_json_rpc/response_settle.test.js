// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict';

const assert = require('assert');
const http = require('http');
const { postJsonRpc, blockWatchdogDeadline } = require('../../../../src/consensus/peer_json_rpc/index.js');
const AnchorProofClient = require('../../../../src/consensus/doge_peer_clients/anchor_proof_client.js');
const { RollcallProofClient } = require('../../../../src/consensus/doge_peer_clients/rollcall_proof_client.js');
const bridgeTransport = require('../../../../src/consensus/bridge_proof_client/transport.js');

function startPeer(handler){
    return new Promise((resolve) => {
        let server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => handler(JSON.parse(body || '{}'), res));
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server: server, url: 'http://127.0.0.1:' + server.address().port + '/' });
        });
    });
}

function settledWithin(promise, ms){
    let outcome = promise.then((value) => ({ type: 'resolved', value: value }),
                               (error) => ({ type: 'rejected', error: error }));
    return Promise.race([outcome, new Promise((resolve) => {
        setTimeout(() => resolve({ type: 'pending' }), ms);
    })]);
}

function truncatedReply(req, res){
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' });
    res.write('{"jsonrpc":"2.0","result":{"partial":');
    setTimeout(() => res.socket.destroy(), 20);
}

// A live peer that sends a valid reply three bytes every 20ms, so the whole body takes
// about 300ms, well past a 100ms idle timeout, while the socket is never idle that long.
const SLOW_CHUNKS = 12;
function slowCompleteReply(req, res){
    let text = JSON.stringify({ jsonrpc: '2.0', result: { pad: 'p'.repeat(SLOW_CHUNKS) } });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(text.length) });
    let at = 0;
    let ticker = setInterval(() => {
        if(at >= text.length){ clearInterval(ticker); return res.end(); }
        res.write(text.slice(at, at + 3));
        at += 3;
    }, 20);
    res.on('close', () => clearInterval(ticker));
}

function dripReply(req, res){
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '5000' });
    let ticker = setInterval(() => res.write('x'), 10);
    res.on('close', () => clearInterval(ticker));
}

let peer = null;

function closePeer(done){
    if(!peer) return done();
    let current = peer;
    peer = null;
    current.server.closeAllConnections && current.server.closeAllConnections();
    current.server.close(() => done());
}

describe('peer JSON-RPC response settling @regression', function(){
    afterEach(closePeer);

    it('rejects a truncated response instead of remaining pending', async function(){
        peer = await startPeer(truncatedReply);
        let outcome = await settledWithin(postJsonRpc({
            url: peer.url, method: 'ping', params: {}, timeoutMs: 1000, deadlineMs: 1000
        }), 500);
        assert.strictEqual(outcome.type, 'rejected');
        assert.match(outcome.error.message, /before the body was complete|Peer response error/);
    });

    it('rejects a drip-fed response at the wall-clock deadline', async function(){
        let ticker = null;
        peer = await startPeer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '5000' });
            ticker = setInterval(() => res.write('x'), 10);
            res.on('close', () => clearInterval(ticker));
        });
        let outcome = await settledWithin(postJsonRpc({
            url: peer.url, method: 'ping', params: {}, timeoutMs: 100, deadlineMs: 100
        }), 500);
        clearInterval(ticker);
        assert.strictEqual(outcome.type, 'rejected');
        assert.match(outcome.error.message, /exceeded its 100ms deadline/);
    });

    it('preserves result, RPC error, and malformed JSON behavior', async function(){
        peer = await startPeer((req, res) => {
            if(req.method === 'ok') return res.end(JSON.stringify({ result: { ok: true } }));
            if(req.method === 'error') return res.end(JSON.stringify({ error: { message: 'denied' } }));
            res.end('{bad json');
        });
        let call = (method) => postJsonRpc({
            url: peer.url, method: method, params: {}, timeoutMs: 500, deadlineMs: 500
        });
        assert.deepStrictEqual(await call('ok'), { ok: true });
        await assert.rejects(call('error'), /denied/);
        await assert.rejects(call('bad'), /Invalid JSON response/);
    });

    it('routes interrupted anchor, rollcall, and bridge calls to their failure paths', async function(){
        peer = await startPeer(truncatedReply);
        let anchor = new AnchorProofClient({}, { url: peer.url, timeoutMs: 500 });
        assert.strictEqual(await anchor.fetch('a'.repeat(64)), null);

        let rollcall = new RollcallProofClient({ NETWORK: 'regtest' }, { url: peer.url, timeoutMs: 500 });
        let answer = await rollcall.fetchSigners({
            epochHeight: 1, maxBlockTime: 2, pubkeys: [], publishers: []
        });
        assert.strictEqual(answer.decided, false);
        assert.match(answer.reason, /unreachable/);

        await assert.rejects(bridgeTransport.rpc(
            { url: peer.url, apiKey: '' }, 'getbridgeescrowproof', {}, 500
        ), /before the body was complete|Peer response error/);
    });
});

describe('peer JSON-RPC wall-clock bound follows the block watchdog @regression', function(){
    afterEach(closePeer);

    it('resolves a complete reply that streams for longer than the idle timeout', async function(){
        peer = await startPeer(slowCompleteReply);
        let config = { BLOCK_PROCESS_TIMEOUT: 300000, ZZPEER_INDEXER_URL: peer.url };
        let anchor = new AnchorProofClient(config, { url: peer.url, timeoutMs: 100 });
        let rollcall = new RollcallProofClient(config, { url: peer.url, timeoutMs: 100 });
        let endpoint = bridgeTransport.resolveOriginEndpoint('ZZPEER', config);
        assert.strictEqual(endpoint.deadlineMs, 300000);
        for(let call of [() => anchor.rpc('m', {}), () => rollcall.rpc('m', {}),
                         () => bridgeTransport.rpc(endpoint, 'm', {}, 100)]){
            let outcome = await settledWithin(call(), 2000);
            assert.strictEqual(outcome.type, 'resolved', outcome.error && outcome.error.message);
            assert.deepStrictEqual(outcome.value, { pad: 'p'.repeat(SLOW_CHUNKS) });
        }
    });

    it('bounds a drip-fed reply by the configured block watchdog', async function(){
        peer = await startPeer(dripReply);
        let config = { NETWORK: 'regtest', BLOCK_PROCESS_TIMEOUT: 150, ZZPEER_INDEXER_URL: peer.url };
        let anchor = new AnchorProofClient(config, { url: peer.url, timeoutMs: 100 });
        let outcome = await settledWithin(anchor.fetch('a'.repeat(64)), 1500);
        assert.deepStrictEqual(outcome, { type: 'resolved', value: null });

        let rollcall = new RollcallProofClient(config, { url: peer.url, timeoutMs: 100 });
        outcome = await settledWithin(rollcall.fetchSigners({
            epochHeight: 1, maxBlockTime: 2, pubkeys: [], publishers: []
        }), 1500);
        assert.strictEqual(outcome.type, 'resolved');
        assert.strictEqual(outcome.value.decided, false);

        let endpoint = bridgeTransport.resolveOriginEndpoint('ZZPEER', config);
        outcome = await settledWithin(bridgeTransport.rpc(endpoint, 'm', {}, 100), 1500);
        assert.strictEqual(outcome.type, 'rejected');
        assert.match(outcome.error.message, /exceeded its 150ms deadline/);
    });

    it('arms no wall-clock deadline without a positive block watchdog', function(){
        for(let value of [undefined, null, 0, -1, 'x', NaN]){
            assert.strictEqual(blockWatchdogDeadline({ BLOCK_PROCESS_TIMEOUT: value }), undefined);
        }
        assert.strictEqual(blockWatchdogDeadline(undefined), undefined);
        assert.strictEqual(blockWatchdogDeadline({ BLOCK_PROCESS_TIMEOUT: 300000 }), 300000);
    });
});

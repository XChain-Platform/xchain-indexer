// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert    = require('assert');
const sinon     = require('sinon');
const http      = require('http');
const https     = require('https');
const EventEmitter = require('events');
const HubClient = require('../../src/hub_client.js');

function buildHttpStub(responseBody){
    let fakeReq = new EventEmitter();
    fakeReq.write = sinon.stub();
    fakeReq.end   = sinon.stub();
    fakeReq.destroy = sinon.stub().callsFake(function(err){ fakeReq.emit('error', err); });

    let stub = sinon.stub().callsFake(function(opts, cb){
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

describe('HubClient', function(){

    afterEach(function(){
        sinon.restore();
        delete process.env.HUB_API_URL;
        delete process.env.HUB_API_KEY;
        delete process.env.HUB_CONFIG_URL;
        delete process.env.HUB_CONFIG_API_KEY;
    });

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

        it('defaults the config endpoint to the feed endpoint when unset', function(){
            let c = new HubClient('http://hub.example.com', 'key1');
            assert.strictEqual(c.configUrl, 'http://hub.example.com');
            assert.strictEqual(c.configApiKey, 'key1');
            assert.strictEqual(c.configEnabled, true);
        });

        it('separates the config endpoint from the feed endpoint via env', function(){
            process.env.HUB_CONFIG_URL     = 'http://private-hub.example.com:10000';
            process.env.HUB_CONFIG_API_KEY = 'privatekey';
            let c = new HubClient('http://validator01.example.com:10002', 'feedkey');
            assert.strictEqual(c.hubUrl, 'http://validator01.example.com:10002');
            assert.strictEqual(c.apiKey, 'feedkey');
            assert.strictEqual(c.configUrl, 'http://private-hub.example.com:10000');
            assert.strictEqual(c.configApiKey, 'privatekey');
        });

        it('marks configEnabled=false when neither a config nor a feed url exists', function(){
            let c = new HubClient('', '');
            assert.strictEqual(c.configEnabled, false);
        });

        it('marks configEnabled=true from HUB_CONFIG_URL alone, with no feed url', function(){
            process.env.HUB_CONFIG_URL = 'http://private-hub.example.com:10000';
            let c = new HubClient('', '');
            assert.strictEqual(c.enabled, false);
            assert.strictEqual(c.configEnabled, true);
        });
    });

    describe('getAllConfigs()', function(){
        it('sends getallconfigs to the CONFIG endpoint, not the feed endpoint', async function(){
            let c = new HubClient('http://validator01.example.com:10002', 'feedkey',
                                  'http://private-hub.example.com:10000', 'privatekey');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: { configs: { BTC: {} }, seq: 4, watermark: 9 }
            }));
            sinon.stub(http, 'request').callsFake(stub);

            let result = await c.getAllConfigs();
            let opts = stub.firstCall.args[0];
            // The whole point of the split: this method must never reach the public feed
            // port, which answers it with -32601 'Method not available on this port'.
            assert.strictEqual(opts.hostname, 'private-hub.example.com');
            assert.strictEqual(opts.port, '10000');
            assert.strictEqual(opts.headers['x-api-key'], 'privatekey');
            assert.deepStrictEqual(result, { configs: { BTC: {} }, seq: 4, watermark: 9 });
        });

        it('still reaches the feed endpoint when no config endpoint is configured', async function(){
            let c = new HubClient('http://hub.example.com:3003', 'feedkey');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: { configs: {}, seq: 0 }
            }));
            sinon.stub(http, 'request').callsFake(stub);

            await c.getAllConfigs();
            let opts = stub.firstCall.args[0];
            assert.strictEqual(opts.hostname, 'hub.example.com');
            assert.strictEqual(opts.headers['x-api-key'], 'feedkey');
        });

        it('resolves null without any request when no endpoint is configured', async function(){
            let c = new HubClient('', '');
            let httpStub = sinon.stub(http, 'request');
            assert.strictEqual(await c.getAllConfigs(), null);
            assert.strictEqual(httpStub.called, false);
        });

        it('leaves push traffic on the feed endpoint when a config endpoint is set', async function(){
            let c = new HubClient('http://validator01.example.com:10002', 'feedkey',
                                  'http://private-hub.example.com:10000', 'privatekey');
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: { accepted: true }
            }));
            sinon.stub(http, 'request').callsFake(stub);

            await c.pushChainTip('BTC', 'testnet', 100, 1788202505);
            let opts = stub.firstCall.args[0];
            assert.strictEqual(opts.hostname, 'validator01.example.com');
            assert.strictEqual(opts.headers['x-api-key'], 'feedkey');
        });
    });

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

    // ─── Application-level hub rejections ride INSIDE a successful envelope (item 4279) ─────
    // _call rejects only on a top-level JSON-RPC `error`, but the hub signals push failures in
    // the RESULT: PriceAggregator returns { accepted:false, reason } and api.js returns
    // { error:'...' } as an ordinary method result. Resolving those told HubPushQueue and
    // XChainIndexer's post-commit path the push was delivered, and both then DELETE the durable
    // pending_hub_pushes row, so a transient hub rejection destroyed a never-re-derivable price.
    describe('hub-rejection classification', function(){

        const TRANSIENT = [
            ['{accepted:false} validator snapshot unavailable', { accepted: false, reason: 'validator snapshot unavailable' }],
            ['{accepted:false} db error',                       { accepted: false, reason: 'db error' }],
            ['{error} aggregator still booting',                { error: 'price aggregator not ready' }],
            ['{error} handler exception',                       { error: 'error processing oracle price' }],
            ['an unrecognised reason (retry is the safe side)', { accepted: false, reason: 'some future reason' }]
        ];

        for(const [label, result] of TRANSIENT){
            it('throws on ' + label + ' so the durable row is retried, not deleted', async function(){
                let c = new HubClient('http://hub.example.com', '');
                sinon.stub(c, '_call').resolves(result);
                await assert.rejects(() => c.pushOraclePrice({ value: '1' }), /hub rejected pushoracleprice/);
                await assert.rejects(() => c.pushPriceRound({ round: 1 }),    /hub rejected pushpriceround/);
            });
        }

        const TERMINAL = [
            ['duplicate',                     { accepted: false, reason: 'duplicate' }],
            ['stale (retracted generation)',  { accepted: false, reason: 'stale (retracted generation)' }],
            ['invalid sigs',                  { accepted: false, reason: 'invalid sigs' }],
            ['insufficient quorum (1/3)',     { accepted: false, reason: 'insufficient quorum (1/3)' }],
            ['a missing-field guard',         { error: 'source_chain is required' }],
            ['a multi-field guard',           { error: 'coin, tick, fiat, value are required' }],
            ['an unknown chain',              { error: 'chain must be one of: BTC, LTC, DOGE' }]
        ];

        for(const [label, result] of TERMINAL){
            it('resolves on terminal rejection "' + label + '" so the row is dropped, not retried forever', async function(){
                let c = new HubClient('http://hub.example.com', '');
                sinon.stub(c, '_call').resolves(result);
                assert.deepStrictEqual(await c.pushOraclePrice({ value: '1' }), result);
                assert.deepStrictEqual(await c.pushPriceRound({ round: 1 }), result);
            });
        }

        it('resolves an accepted push untouched', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').resolves({ accepted: true });
            assert.deepStrictEqual(await c.pushOraclePrice({ value: '1' }), { accepted: true });
        });

        it('carries the reason on the thrown error for the queue log', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').resolves({ accepted: false, reason: 'db error' });
            await assert.rejects(() => c.pushOraclePrice({}), (err) => {
                assert.strictEqual(err.hubRejection, 'db error');
                return true;
            });
        });

        it('throws on a retraction the hub could not apply (retractions retry forever)', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').resolves({ error: 'error retracting prices' });
            await assert.rejects(() => c.retractPriceRange('BTC', 10), /hub rejected pushpricereorg/);
        });

        it('resolves a successful retraction result untouched', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').resolves({ retracted: { price_snapshots: 2, oracle_prices: 0 } });
            assert.deepStrictEqual(await c.retractPriceRange('BTC', 10),
                { retracted: { price_snapshots: 2, oracle_prices: 0 } });
        });
    });

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
            // No bound or generation passed => neither key present (open-ended, no fence).
            assert.ok(!('to_action_index' in payload));
            assert.ok(!('retraction_generation' in payload));
        });

        it('threads to_action_index + retraction_generation into the payload when given (items 5296/5308)', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            await c.retractPriceRange('BTC', 50, 75, 5);
            let payload = callStub.firstCall.args[1];
            assert.strictEqual(payload.from_action_index, 50);
            assert.strictEqual(payload.to_action_index, 75);
            assert.strictEqual(payload.retraction_generation, 5);
        });

        it('threads retraction_generation on an open-ended (live) retraction (to=null)', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            await c.retractPriceRange('BTC', 50, null, 7);
            let payload = callStub.firstCall.args[1];
            assert.ok(!('to_action_index' in payload), 'no closed-range bound');
            assert.strictEqual(payload.retraction_generation, 7);
        });

        it('propagates rejection from _call', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(new Error('reorg error'));
            await assert.rejects(() => c.retractPriceRange('BTC', 1), /reorg error/);
        });
    });

    describe('retractXcallRange()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            let result = await c.retractXcallRange('BTC', 42);
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushxcallreorg and correct payload', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            await c.retractXcallRange('LTC', 999);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushxcallreorg');
            let payload = callStub.firstCall.args[1];
            assert.strictEqual(payload.source_chain, 'LTC');
            assert.strictEqual(payload.from_action_index, 999);
        });

        it('propagates rejection from _call', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(new Error('xcall reorg error'));
            await assert.rejects(() => c.retractXcallRange('BTC', 1), /xcall reorg error/);
        });
    });

    describe('retractMatchRange()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            let result = await c.retractMatchRange('BTC', 42);
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushdexreorg and correct payload', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            await c.retractMatchRange('LTC', 999);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushdexreorg');
            let payload = callStub.firstCall.args[1];
            assert.strictEqual(payload.source_chain, 'LTC');
            assert.strictEqual(payload.from_action_index, 999);
        });

        it('propagates rejection from _call', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(new Error('dex reorg error'));
            await assert.rejects(() => c.retractMatchRange('BTC', 1), /dex reorg error/);
        });
    });

    describe('pushPriceBatch()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, '_call').resolves({});
            let result = await c.pushPriceBatch({ first_round: 1, last_round: 6 });
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushpricebatch and passes batchData verbatim', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, '_call').resolves({ ok: true });
            let batchData = {
                source_chain:     'BTC',
                first_round:      1,
                last_round:       6,
                btc_block_height: 900000,
                rounds:           [{ round: 1, timestamp: 1700000000, btc_block_height: 900000, pairs: [] }],
                sigs:             [{ pubkey: 'a', sig: 'b' }],
                action_index:     42,
                block_index:      7,
                push_generation:  0,
                block_time:       1700000600
            };
            let result = await c.pushPriceBatch(batchData);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushpricebatch');
            assert.strictEqual(callStub.firstCall.args[1], batchData);
            assert.deepStrictEqual(result, { ok: true });
        });

        it('propagates rejection from _call (not swallowed)', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(new Error('rpc error'));
            await assert.rejects(() => c.pushPriceBatch({}), /rpc error/);
        });

        it('throws on a transient hub rejection so the durable row is retried, not deleted', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').resolves({ accepted: false, reason: 'validator snapshot unavailable' });
            await assert.rejects(() => c.pushPriceBatch({ first_round: 1, last_round: 6 }),
                /hub rejected pushpricebatch/);
        });

        it('resolves on a terminal hub rejection so the row is dropped, not retried forever', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let result = { accepted: false, reason: 'duplicate' };
            sinon.stub(c, '_call').resolves(result);
            assert.deepStrictEqual(await c.pushPriceBatch({ first_round: 1, last_round: 6 }), result);
        });
    });

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

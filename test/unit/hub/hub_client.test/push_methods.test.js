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
// HubClient push methods: pushChainTip, pushPriceRound, pushOraclePrice and
// pushPriceBatch against a stubbed call(): the disabled guard, the method name
// and payload each sends, and whether a call rejection is swallowed or
// propagated.
// Part of the HubClient suite; see ../hub_client.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert    = require('assert');
const sinon     = require('sinon');
const HubClient = require('../../../../src/hub/hub_client.js');
const { restoreStubsAndHubEnv } = require('./helpers/hub_client_fixtures.js');

// -----------------------------------------------------------------------
// pushChainTip: public-method guard + call stubbing
// -----------------------------------------------------------------------
describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('pushChainTip()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, 'call').resolves({});
            await c.pushChainTip('BTC', 'mainnet', 800000, 1700000000);
            assert.strictEqual(callStub.callCount, 0);
        });

        it('calls _call with pushchaintip and correct payload', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, 'call').resolves({});
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
            sinon.stub(c, 'call').rejects(new Error('hub down'));
            // Must NOT throw
            await assert.doesNotReject(() => c.pushChainTip('BTC', 'mainnet', 1, 1));
        });
    });
});

// -----------------------------------------------------------------------
// pushPriceRound
// -----------------------------------------------------------------------
describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('pushPriceRound()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, 'call').resolves({});
            let result = await c.pushPriceRound({ round: 1 });
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushpriceround and passes roundData', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, 'call').resolves({ ok: true });
            let roundData = { round: 5, coin: 'BTC', price: '64000' };
            let result = await c.pushPriceRound(roundData);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushpriceround');
            assert.strictEqual(callStub.firstCall.args[1], roundData);
            assert.deepStrictEqual(result, { ok: true });
        });

        it('propagates rejection from _call (not swallowed)', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, 'call').rejects(new Error('rpc error'));
            await assert.rejects(() => c.pushPriceRound({}), /rpc error/);
        });
    });
});

// -----------------------------------------------------------------------
// pushOraclePrice
// -----------------------------------------------------------------------
describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('pushOraclePrice()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, 'call').resolves({});
            let result = await c.pushOraclePrice({ price: '100' });
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushoracleprice and passes priceData', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, 'call').resolves({ ok: true });
            let priceData = { tick: 'AAA', price: '1.50' };
            let result = await c.pushOraclePrice(priceData);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushoracleprice');
            assert.strictEqual(callStub.firstCall.args[1], priceData);
            assert.deepStrictEqual(result, { ok: true });
        });

        it('propagates rejection from _call', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, 'call').rejects(new Error('oracle rpc error'));
            await assert.rejects(() => c.pushOraclePrice({}), /oracle rpc error/);
        });
    });
});

describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('pushPriceBatch()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, 'call').resolves({});
            let result = await c.pushPriceBatch({ first_round: 1, last_round: 6 });
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushpricebatch and passes batchData verbatim', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, 'call').resolves({ ok: true });
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
            sinon.stub(c, 'call').rejects(new Error('rpc error'));
            await assert.rejects(() => c.pushPriceBatch({}), /rpc error/);
        });

        it('throws on a transient hub rejection so the durable row is retried, not deleted', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, 'call').resolves({ accepted: false, reason: 'validator snapshot unavailable' });
            await assert.rejects(() => c.pushPriceBatch({ first_round: 1, last_round: 6 }),
                /hub rejected pushpricebatch/);
        });

        it('resolves on a terminal hub rejection so the row is dropped, not retried forever', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let result = { accepted: false, reason: 'duplicate' };
            sinon.stub(c, 'call').resolves(result);
            assert.deepStrictEqual(await c.pushPriceBatch({ first_round: 1, last_round: 6 }), result);
        });
    });
});

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
// HubClient hub-rejection classification: which rejections a successful
// envelope carries are transient (throw, so the durable row is retried) and
// which are terminal (resolve, so the row is dropped).
// Part of the HubClient suite; see ../hub_client.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert    = require('assert');
const sinon     = require('sinon');
const HubClient = require('../../../../src/hub/hub_client.js');
const { restoreStubsAndHubEnv } = require('./helpers/hub_client_fixtures.js');

// ─── Application-level hub rejections ride INSIDE a successful envelope (item 4279) ─────
// call rejects only on a top-level JSON-RPC `error`, but the hub signals push failures in
// the RESULT: PriceAggregator returns { accepted:false, reason } and api.js returns
// { error:'...' } as an ordinary method result. Resolving those told HubPushQueue and
// XChainIndexer's post-commit path the push was delivered, and both then DELETE the durable
// pending_hub_pushes row, so a transient hub rejection destroyed a never-re-derivable price.
describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

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
                sinon.stub(c, 'call').resolves(result);
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
                sinon.stub(c, 'call').resolves(result);
                assert.deepStrictEqual(await c.pushOraclePrice({ value: '1' }), result);
                assert.deepStrictEqual(await c.pushPriceRound({ round: 1 }), result);
            });
        }
    });
});

describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('hub-rejection classification', function(){
        it('resolves an accepted push untouched', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, 'call').resolves({ accepted: true });
            assert.deepStrictEqual(await c.pushOraclePrice({ value: '1' }), { accepted: true });
        });

        it('carries the reason on the thrown error for the queue log', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, 'call').resolves({ accepted: false, reason: 'db error' });
            await assert.rejects(() => c.pushOraclePrice({}), (err) => {
                assert.strictEqual(err.hubRejection, 'db error');
                return true;
            });
        });

        it('throws on a retraction the hub could not apply (retractions retry forever)', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, 'call').resolves({ error: 'error retracting prices' });
            await assert.rejects(() => c.retractPriceRange('BTC', 10), /hub rejected pushpricereorg/);
        });
    });

    describe('hub-rejection classification', function(){
        it('resolves a successful retraction result untouched', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, 'call').resolves({ retracted: { price_snapshots: 2, oracle_prices: 0 } });
            assert.deepStrictEqual(await c.retractPriceRange('BTC', 10),
                { retracted: { price_snapshots: 2, oracle_prices: 0 } });
        });
    });
});

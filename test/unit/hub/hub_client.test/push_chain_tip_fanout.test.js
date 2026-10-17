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
const HubClient = require('../../../../src/hub/hub_client.js');
const { restoreStubsAndHubEnv } = require('./helpers/hub_client_fixtures.js');

describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('pushChainTip() candidate fanout', function(){
        it('pushes to every unpinned candidate', async function(){
            let urls = [1, 2, 3, 4, 5].map((n) => 'http://hub-' + n + '.example.com');
            let c = new HubClient(urls[0], 'key');
            c.setAddressSource(() => urls[0]);
            c.setCandidateSource(() => ({ current: urls[0], candidates: urls, pinned: false }));
            let callStub = sinon.stub(c, 'call').resolves({});

            await c.pushChainTip('BTC', 'regtest', 100, 1700000000);

            assert.strictEqual(callStub.callCount, 5);
            assert.deepStrictEqual(callStub.getCalls().map((call) => call.args[3]), urls);
            for(let call of callStub.getCalls()){
                assert.strictEqual(call.args[0], 'pushchaintip');
                assert.deepStrictEqual(call.args[1], {
                    coin: 'BTC', network: 'regtest', block_height: 100, block_time: 1700000000
                });
            }
        });

        it('pushes only to the current hub when pinned', async function(){
            let current = 'http://pinned.example.com';
            let c = new HubClient(current, 'key');
            c.setAddressSource(() => current);
            c.setCandidateSource(() => ({ current, candidates: [current], pinned: true }));
            let callStub = sinon.stub(c, 'call').resolves({});

            await c.pushChainTip('BTC', 'regtest', 100, 1700000000);

            assert.strictEqual(callStub.callCount, 1);
            assert.strictEqual(callStub.firstCall.args[0], 'pushchaintip');
            assert.strictEqual(callStub.firstCall.args[3], undefined);
        });

        it('waits for every candidate when one push fails', async function(){
            let urls = [1, 2, 3, 4, 5].map((n) => 'http://hub-' + n + '.example.com');
            let c = new HubClient(urls[0], 'key');
            c.setAddressSource(() => urls[0]);
            c.setCandidateSource(() => ({ current: urls[0], candidates: urls, pinned: false }));
            let callStub = sinon.stub(c, 'call').callsFake(async(method, params, key, url) => {
                if(url === urls[1]) throw new Error('hub down');
                return {};
            });

            await assert.doesNotReject(() =>
                c.pushChainTip('BTC', 'regtest', 100, 1700000000));

            assert.strictEqual(callStub.callCount, 5);
            assert.deepStrictEqual(callStub.getCalls().map((call) => call.args[3]), urls);
        });
    });
});

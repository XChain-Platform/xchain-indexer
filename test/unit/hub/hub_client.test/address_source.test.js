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
const HubClient = require('../../../../src/hub/hub_client.js');
const { buildHttpStub, restoreStubsAndHubEnv } = require('./helpers/hub_client_fixtures.js');

describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('setAddressSource()', function(){
        function stubSuccessfulRequest(){
            let { stub } = buildHttpStub(JSON.stringify({
                jsonrpc: '2.0', id: 1, result: { accepted: true }
            }));
            sinon.stub(http, 'request').callsFake(stub);
            return stub;
        }

        it('routes reads through the current source address', async function(){
            let c = new HubClient('http://constructor.example.com', 'key');
            let address = 'http://first.example.com';
            c.setAddressSource(() => address);
            let stub = stubSuccessfulRequest();

            await c.call('getprices', {});
            address = 'http://second.example.com';
            await c.call('getprices', {});

            assert.strictEqual(stub.firstCall.args[0].hostname, 'first.example.com');
            assert.strictEqual(stub.secondCall.args[0].hostname, 'second.example.com');
            assert.strictEqual(c.hubUrl, 'http://constructor.example.com');
            assert.strictEqual(c.configUrl, 'http://constructor.example.com');
            assert.strictEqual(c.enabled, true);
            assert.strictEqual(c.configEnabled, true);
            assert.strictEqual(c.apiKey, 'key');
            assert.strictEqual(c.configApiKey, 'key');
            assert.strictEqual(c.reorgApiKey, 'key');
        });

        it('routes push through the current source address', async function(){
            let c = new HubClient('http://constructor.example.com', 'key');
            c.setAddressSource(() => 'http://current.example.com');
            let stub = stubSuccessfulRequest();

            await c.push('pushpriceround', { round: 1 });

            assert.strictEqual(stub.firstCall.args[0].hostname, 'current.example.com');
        });

        it('routes reorg pushes through the current address with the reorg key', async function(){
            let c = new HubClient('http://constructor.example.com', 'push-key');
            c.reorgApiKey = 'reorg-key';
            c.setAddressSource(() => 'http://current.example.com');
            let stub = stubSuccessfulRequest();

            await c.retractPriceRange('BTC', 10, 20, 3);

            assert.strictEqual(stub.firstCall.args[0].hostname, 'current.example.com');
            assert.strictEqual(stub.firstCall.args[0].headers['x-api-key'], 'reorg-key');
        });

        it('lets a URL override take precedence over the source', async function(){
            let c = new HubClient('http://constructor.example.com', 'key');
            c.setAddressSource(() => 'http://current.example.com');
            let stub = stubSuccessfulRequest();

            await c.call('ping', {}, undefined, 'http://override.example.com');

            assert.strictEqual(stub.firstCall.args[0].hostname, 'override.example.com');
        });

        it('keeps getAllConfigs on the config address', async function(){
            let c = new HubClient('http://constructor.example.com', 'feed-key',
                                  'http://config.example.com', 'config-key');
            let address = 'http://current.example.com';
            c.setAddressSource(() => address);
            let stub = stubSuccessfulRequest();

            address = 'http://moved.example.com';
            await c.getAllConfigs();

            assert.strictEqual(stub.firstCall.args[0].hostname, 'config.example.com');
            assert.strictEqual(stub.firstCall.args[0].headers['x-api-key'], 'config-key');
        });

        it('falls back to the constructor address for empty and non-string source values', async function(){
            let c = new HubClient('http://constructor.example.com', 'key');
            let address = '';
            c.setAddressSource(() => address);
            let stub = stubSuccessfulRequest();

            await c.call('ping', {});
            address = { url: 'http://ignored.example.com' };
            await c.call('ping', {});

            assert.strictEqual(stub.firstCall.args[0].hostname, 'constructor.example.com');
            assert.strictEqual(stub.secondCall.args[0].hostname, 'constructor.example.com');
        });

        it('uses the constructor address when no source is set', async function(){
            let c = new HubClient('http://constructor.example.com', 'key');
            let stub = stubSuccessfulRequest();

            await c.call('ping', {});

            assert.strictEqual(stub.firstCall.args[0].hostname, 'constructor.example.com');
        });

        it('logs one startup warning when seeds are set without a config or API address', function(){
            process.env.HUB_SEED_URLS = 'http://seed.example.com:10002';
            let warn = sinon.stub(console, 'warn');

            let c = new HubClient('', '');

            assert.strictEqual(c.enabled, false);
            assert.strictEqual(c.configEnabled, false);
            assert.strictEqual(warn.callCount, 1);
            assert.match(warn.firstCall.args[0], /config poll is off.*no config or API address/i);
        });
    });
});

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
// HubClient (src/hub/hub_client.js), mock-based: no socket is opened, the
// transport is a stubbed http(s).request or a stubbed call().
//
// This file holds the constructor (feed and config endpoint wiring) and
// getAllConfigs() routing. The push methods, the hub-rejection classification,
// the retraction methods and the raw _call() HTTP path live beside it in
// hub_client.test/, each opening the same 'HubClient' describe so every full
// test title is unchanged; hub_client.test/helpers/hub_client_fixtures.js holds
// the fake http.request builder and the afterEach they share.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert    = require('assert');
const sinon     = require('sinon');
const http      = require('http');
const HubClient = require('../../../src/hub/hub_client.js');
const { requireWithFreshConfig } = require('../../helpers/fresh_config.js');
const HUB_CLIENT_PATH = require.resolve('../../../src/hub/hub_client.js');
const { buildHttpStub, restoreStubsAndHubEnv } = require('./hub_client.test/helpers/hub_client_fixtures.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// -----------------------------------------------------------------------
// constructor
// -----------------------------------------------------------------------
describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('constructor', function(){
        it('uses provided hubUrl and marks enabled=true', function(){
            let c = new HubClient('http://hub.example.com', 'key1');
            assert.strictEqual(c.enabled, true);
            assert.strictEqual(c.hubUrl, 'http://hub.example.com');
            assert.strictEqual(c.apiKey, 'key1');
        });

        // The env fallbacks read src/config.js's load-time CONFIG_ENV snapshot, so each
        // case that sets env loads a fresh HubClient after writing it.
        it('falls back to env vars when constructor args missing', function(){
            process.env.HUB_API_URL = 'http://env-hub.example.com';
            process.env.HUB_API_KEY = 'envkey';
            const FreshHubClient = requireWithFreshConfig(HUB_CLIENT_PATH);
            let c = new FreshHubClient();
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
            const FreshHubClient = requireWithFreshConfig(HUB_CLIENT_PATH);
            let c = new FreshHubClient();
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
            const FreshHubClient = requireWithFreshConfig(HUB_CLIENT_PATH);
            let c = new FreshHubClient('http://validator01.example.com:10002', 'feedkey');
            assert.strictEqual(c.hubUrl, 'http://validator01.example.com:10002');
            assert.strictEqual(c.apiKey, 'feedkey');
            assert.strictEqual(c.configUrl, 'http://private-hub.example.com:10000');
            assert.strictEqual(c.configApiKey, 'privatekey');
        });

        it('marks configEnabled=false when neither a config nor a feed url exists', function(){
            let c = new HubClient('', '');
            assert.strictEqual(c.configEnabled, false);
        });
    });
});

describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('constructor', function(){
        it('marks configEnabled=true from HUB_CONFIG_URL alone, with no feed url', function(){
            process.env.HUB_CONFIG_URL = 'http://private-hub.example.com:10000';
            const FreshHubClient = requireWithFreshConfig(HUB_CLIENT_PATH);
            let c = new FreshHubClient('', '');
            assert.strictEqual(c.enabled, false);
            assert.strictEqual(c.configEnabled, true);
        });
    });
});

describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

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
});

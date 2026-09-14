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
// HubClient retraction methods: retractPriceRange, retractXcallRange and
// retractMatchRange against a stubbed call(): the disabled guard, the reorg
// method and payload each sends, and rejection propagation.
// Part of the HubClient suite; see ../hub_client.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert    = require('assert');
const sinon     = require('sinon');
const HubClient = require('../../../src/hub/hub_client.js');
const { restoreStubsAndHubEnv } = require('./helpers/hub_client_fixtures.js');

// -----------------------------------------------------------------------
// retractPriceRange
// -----------------------------------------------------------------------
describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('retractPriceRange()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, 'call').resolves({});
            let result = await c.retractPriceRange('BTC', 42);
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushpricereorg and correct payload', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, 'call').resolves({});
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
            let callStub = sinon.stub(c, 'call').resolves({});
            await c.retractPriceRange('BTC', 50, 75, 5);
            let payload = callStub.firstCall.args[1];
            assert.strictEqual(payload.from_action_index, 50);
            assert.strictEqual(payload.to_action_index, 75);
            assert.strictEqual(payload.retraction_generation, 5);
        });

        it('threads retraction_generation on an open-ended (live) retraction (to=null)', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, 'call').resolves({});
            await c.retractPriceRange('BTC', 50, null, 7);
            let payload = callStub.firstCall.args[1];
            assert.ok(!('to_action_index' in payload), 'no closed-range bound');
            assert.strictEqual(payload.retraction_generation, 7);
        });

        it('propagates rejection from _call', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, 'call').rejects(new Error('reorg error'));
            await assert.rejects(() => c.retractPriceRange('BTC', 1), /reorg error/);
        });
    });
});

// -----------------------------------------------------------------------
// retractXcallRange
// -----------------------------------------------------------------------
describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('retractXcallRange()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, 'call').resolves({});
            let result = await c.retractXcallRange('BTC', 42);
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushxcallreorg and correct payload', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, 'call').resolves({});
            await c.retractXcallRange('LTC', 999);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushxcallreorg');
            let payload = callStub.firstCall.args[1];
            assert.strictEqual(payload.source_chain, 'LTC');
            assert.strictEqual(payload.from_action_index, 999);
        });

        it('propagates rejection from _call', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, 'call').rejects(new Error('xcall reorg error'));
            await assert.rejects(() => c.retractXcallRange('BTC', 1), /xcall reorg error/);
        });
    });
});

// -----------------------------------------------------------------------
// retractMatchRange
// -----------------------------------------------------------------------
describe('HubClient', function(){
    afterEach(restoreStubsAndHubEnv);

    describe('retractMatchRange()', function(){
        it('returns immediately without calling _call when not enabled', async function(){
            let c = new HubClient('', '');
            let callStub = sinon.stub(c, 'call').resolves({});
            let result = await c.retractMatchRange('BTC', 42);
            assert.strictEqual(callStub.callCount, 0);
            assert.strictEqual(result, undefined);
        });

        it('calls _call with pushdexreorg and correct payload', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let callStub = sinon.stub(c, 'call').resolves({});
            await c.retractMatchRange('LTC', 999);
            assert.strictEqual(callStub.calledOnce, true);
            assert.strictEqual(callStub.firstCall.args[0], 'pushdexreorg');
            let payload = callStub.firstCall.args[1];
            assert.strictEqual(payload.source_chain, 'LTC');
            assert.strictEqual(payload.from_action_index, 999);
        });

        it('propagates rejection from _call', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, 'call').rejects(new Error('dex reorg error'));
            await assert.rejects(() => c.retractMatchRange('BTC', 1), /dex reorg error/);
        });
    });
});

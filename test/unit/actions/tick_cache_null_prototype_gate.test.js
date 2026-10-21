// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const gateRegistry = require('../../../src/consensus/gate_registry.js');
const { stubGate } = require('../../helpers/gate_modules.js');
const { fetchAirdropTicks } = require('../../../src/actions/airdrop/legs.js');
const { loadTicks } = require('../../../src/actions/destroy/legs.js');
const { prefetchSendContext } = require('../../../src/actions/send/prefetch.js');

const GATE = 'tick_cache_null_prototype_activation.TICK_CACHE_NULL_PROTOTYPE_ACTIVATION';
const BLOCK_INDEX = 37;
const ACTION_INDEX = 4;
const DATA = Object.freeze({ BLOCK_INDEX, ACTION_INDEX, BLOCK_TIME: 0 });
const PROTOTYPE_TICKS = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];

function context(){
    return {
        config: { NETWORK: 'regtest', COIN: 'BTC' },
        indexerDb: {
            getTokenInfo: sinon.stub().resolves(null),
            getAddressPreferences: sinon.stub().resolves({}),
            getGatedPackThresholds: sinon.stub().resolves([]),
        },
    };
}

function assertFetchedPrototypeTicks(cache, handler, trailingArgs = []){
    assert.strictEqual(Object.getPrototypeOf(cache), null);
    assert.deepStrictEqual(Object.keys(cache), PROTOTYPE_TICKS);
    for(const tick of PROTOTYPE_TICKS){
        assert.strictEqual(Object.prototype.hasOwnProperty.call(cache, tick), true);
        assert.strictEqual(cache[tick], null);
        sinon.assert.calledWithExactly(
            handler.indexerDb.getTokenInfo, tick, BLOCK_INDEX, ACTION_INDEX, ...trailingArgs);
    }
}

describe('TICK cache null-prototype activation @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('keeps live networks unarmed and enables regtest from genesis', function () {
        assert.strictEqual(gateRegistry.activeAt(GATE, 'mainnet', 'BTC', 0, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'testnet', 'BTC', 0, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'BTC', 0, null), true);
    });

    it('switches AIRDROP from the inherited cache immediately below the boundary', async function () {
        stubGate(sinon, GATE, false).callsFake((key, network, coin, height) => height >= BLOCK_INDEX);
        const handler = context();
        const below = await fetchAirdropTicks.call(
            handler, PROTOTYPE_TICKS.map((tick) => [tick]), { ...DATA, BLOCK_INDEX: BLOCK_INDEX - 1 });
        const active = await fetchAirdropTicks.call(
            handler, PROTOTYPE_TICKS.map((tick) => [tick]), DATA);

        assert.strictEqual(Object.getPrototypeOf(below), Object.prototype);
        assert.deepStrictEqual(Object.keys(below), []);
        assertFetchedPrototypeTicks(active, handler);
    });

    it('uses a null-prototype TICK cache in AIRDROP at the gate', async function () {
        const gate = stubGate(sinon, GATE, true);
        const handler = context();
        const cache = await fetchAirdropTicks.call(
            handler, PROTOTYPE_TICKS.map((tick) => [tick]), DATA);

        assertFetchedPrototypeTicks(cache, handler);
        assert.strictEqual(gate.calledWith('regtest', 'BTC', BLOCK_INDEX, null), true);
    });

    it('uses a null-prototype TICK cache in SEND at the gate', async function () {
        const gate = stubGate(sinon, GATE, true);
        const handler = context();
        const contextResult = await prefetchSendContext.call(handler,
            PROTOTYPE_TICKS.map((tick, index) => [tick, '1', `destination-${index}`]), DATA);

        assertFetchedPrototypeTicks(contextResult.ticks, handler, [{ supply: false }]);
        assert.strictEqual(gate.calledWith('regtest', 'BTC', BLOCK_INDEX, null), true);
    });

    it('uses a null-prototype TICK cache in DESTROY at the gate', async function () {
        const gate = stubGate(sinon, GATE, true);
        const handler = context();
        const cache = await loadTicks.call(
            handler, PROTOTYPE_TICKS.map((tick) => [tick]), DATA);

        assertFetchedPrototypeTicks(cache, handler);
        assert.strictEqual(gate.calledWith('regtest', 'BTC', BLOCK_INDEX, null), true);
    });
});

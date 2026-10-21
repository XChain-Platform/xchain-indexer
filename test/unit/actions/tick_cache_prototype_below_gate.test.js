// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { fetchAirdropTicks } = require('../../../src/actions/airdrop/legs.js');
const { loadTicks } = require('../../../src/actions/destroy/legs.js');
const { prefetchSendContext } = require('../../../src/actions/send/prefetch.js');

const BLOCK_INDEX = 123;
const ACTION_INDEX = 7;
const DATA = { BLOCK_INDEX, ACTION_INDEX, BLOCK_TIME: 0 };
const PROTOTYPE_TICKS = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];

function assertPlainCacheWithoutOwnPrototypeTicks(cache) {
    assert.strictEqual(Object.getPrototypeOf(cache), Object.prototype);
    assert.deepStrictEqual(Object.keys(cache), []);
    for(const tick of PROTOTYPE_TICKS)
        assert.strictEqual(Object.prototype.hasOwnProperty.call(cache, tick), false);
    for(const tick of PROTOTYPE_TICKS.slice(0, 3))
        assert.strictEqual(cache[tick], Object.prototype[tick]);
    assert.strictEqual(cache.__proto__, Object.prototype);
}

describe('plain-object TICK caches below the prototype gate @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('fetchAirdropTicks reads an ordinary repeated TICK once and caches it under its own name', async function () {
        const tokenInfo = { TICK: 'ALPHA' };
        const getTokenInfo = sinon.stub().resolves(tokenInfo);

        const ticks = await fetchAirdropTicks.call(
            { indexerDb: { getTokenInfo } },
            [['ALPHA'], ['ALPHA']],
            DATA
        );

        sinon.assert.calledOnceWithExactly(getTokenInfo, 'ALPHA', BLOCK_INDEX, ACTION_INDEX);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(ticks, 'ALPHA'), true);
        assert.strictEqual(ticks.ALPHA, tokenInfo);
    });

    it('fetchAirdropTicks skips Object.prototype-named TICKs and leaves no own cache keys', async function () {
        const getTokenInfo = sinon.stub().resolves({});

        const ticks = await fetchAirdropTicks.call(
            { indexerDb: { getTokenInfo } },
            PROTOTYPE_TICKS.map((tick) => [tick]),
            DATA
        );

        sinon.assert.notCalled(getTokenInfo);
        assertPlainCacheWithoutOwnPrototypeTicks(ticks);
    });

    it('loadTicks reads an ordinary repeated TICK once and caches it under its own name', async function () {
        const tokenInfo = { TICK: 'ALPHA' };
        const getTokenInfo = sinon.stub().resolves(tokenInfo);

        const ticks = await loadTicks.call(
            { indexerDb: { getTokenInfo } },
            [['ALPHA'], ['ALPHA']],
            DATA
        );

        sinon.assert.calledOnceWithExactly(getTokenInfo, 'ALPHA', BLOCK_INDEX, ACTION_INDEX);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(ticks, 'ALPHA'), true);
        assert.strictEqual(ticks.ALPHA, tokenInfo);
    });

    it('loadTicks skips Object.prototype-named TICKs and leaves no own cache keys', async function () {
        const getTokenInfo = sinon.stub().resolves({});

        const ticks = await loadTicks.call(
            { indexerDb: { getTokenInfo } },
            PROTOTYPE_TICKS.map((tick) => [tick]),
            DATA
        );

        sinon.assert.notCalled(getTokenInfo);
        assertPlainCacheWithoutOwnPrototypeTicks(ticks);
    });

    it('prefetchSendContext reads an ordinary repeated TICK and its gated packs once', async function () {
        const tokenInfo = { TICK: 'ALPHA' };
        const getTokenInfo = sinon.stub().resolves(tokenInfo);
        const getAddressPreferences = sinon.stub().resolves({});
        const getGatedPackThresholds = sinon.stub().resolves([{ threshold: '1' }]);
        const handler = {
            config: { NETWORK: 'regtest' },
            indexerDb: { getTokenInfo, getAddressPreferences, getGatedPackThresholds }
        };

        const context = await prefetchSendContext.call(
            handler,
            [['ALPHA', '1', 'destination'], ['ALPHA', '2', 'destination']],
            DATA
        );

        sinon.assert.calledOnceWithExactly(
            getTokenInfo,
            'ALPHA',
            BLOCK_INDEX,
            ACTION_INDEX,
            { supply: false }
        );
        sinon.assert.calledOnceWithExactly(getGatedPackThresholds, 'ALPHA');
        assert.strictEqual(Object.prototype.hasOwnProperty.call(context.ticks, 'ALPHA'), true);
        assert.strictEqual(context.ticks.ALPHA, tokenInfo);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(context.gatedPacks, 'ALPHA'), true);
        assert.deepStrictEqual(context.gatedPacks.ALPHA, [{ threshold: '1' }]);
    });

    it('prefetchSendContext skips reads for Object.prototype-named TICKs in both caches', async function () {
        const getTokenInfo = sinon.stub().resolves({});
        const getAddressPreferences = sinon.stub().resolves({});
        const getGatedPackThresholds = sinon.stub().resolves([]);
        const handler = {
            config: { NETWORK: 'regtest' },
            indexerDb: { getTokenInfo, getAddressPreferences, getGatedPackThresholds }
        };
        const sends = PROTOTYPE_TICKS.map((tick, index) => [tick, '1', `destination-${index}`]);

        const context = await prefetchSendContext.call(handler, sends, DATA);

        sinon.assert.notCalled(getTokenInfo);
        sinon.assert.notCalled(getGatedPackThresholds);
        assertPlainCacheWithoutOwnPrototypeTicks(context.ticks);
        assertPlainCacheWithoutOwnPrototypeTicks(context.gatedPacks);
    });
});

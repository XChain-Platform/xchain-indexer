'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC, https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../../fixtures/mocks');
const gateRegistry = require('../../../../src/consensus/gate_registry');
const Vote = require('../../../../src/actions/vote/index.js');

const ENV = 'XC_VOTE_V3_TICK_EXISTENCE_REGTEST_ACTIVATION';
const KEY = 'vote_v3_tick_existence_activation.VOTE_V3_TICK_EXISTENCE_ACTIVATION';
const DELEGATE = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

async function runUnknownTick(network, blockIndex) {
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;
    indexer.config.COIN = 'BTC';
    indexer.indexerDb.getTokenInfo.resolves(false);
    indexer.indexerDb.createVoteDelegation = sinon.stub().resolves();

    const actions = {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(false),
        },
    };
    const data = createBaseData({ ACTION: 'VOTE', FORMAT: 3, BLOCK_INDEX: blockIndex });
    await new Vote(actions).parse(['3', 'UNKNOWN', DELEGATE, ''], data, null);
    return { data, indexer };
}

describe('VOTE v3 TICK existence activation @regression @tier1', function () {
    afterEach(function () {
        delete process.env[ENV];
        sinon.restore();
    });

    it('keeps the legacy accepted row while regtest is unarmed', async function () {
        delete process.env[ENV];
        const { data, indexer } = await runUnknownTick('regtest', 100);
        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(indexer.indexerDb.createVoteDelegation.calledOnce);
    });

    it('refuses an unknown TICK and stores no row when armed', async function () {
        process.env[ENV] = 'armed';
        const { data, indexer } = await runUnknownTick('regtest', 100);
        assert.strictEqual(data.STATUS, 'invalid: TICK (unknown)');
        assert.ok(indexer.indexerDb.createVoteDelegation.notCalled);
    });

    it('switches verdicts exactly at the configured height boundary', async function () {
        process.env[ENV] = '100';
        const below = await runUnknownTick('regtest', 99);
        const at = await runUnknownTick('regtest', 100);
        assert.strictEqual(below.data.STATUS, 'valid');
        assert.ok(below.indexer.indexerDb.createVoteDelegation.calledOnce);
        assert.strictEqual(at.data.STATUS, 'invalid: TICK (unknown)');
        assert.ok(at.indexer.indexerDb.createVoteDelegation.notCalled);
    });

    it('stays unarmed on mainnet even when the regtest variable is armed', async function () {
        process.env[ENV] = 'armed';
        const { data, indexer } = await runUnknownTick('mainnet', 5000000);
        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(indexer.indexerDb.createVoteDelegation.calledOnce);
    });

    it('stays unarmed on testnet even when the regtest variable is armed', async function () {
        process.env[ENV] = 'armed';
        const { data, indexer } = await runUnknownTick('testnet', 5000000);
        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(indexer.indexerDb.createVoteDelegation.calledOnce);
    });

    it('publishes the intended network activation table', function () {
        delete process.env[ENV];
        for (const network of ['mainnet', 'testnet', 'regtest'])
            assert.strictEqual(gateRegistry.activeAt(KEY, network, 'BTC', 5000000, null), false, network);
        process.env[ENV] = 'armed';
        assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'mainnet', 'BTC', 5000000, null), false);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', 'BTC', 5000000, null), false);
    });
});

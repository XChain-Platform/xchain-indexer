'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC, https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const gateRegistry = require('../../../../../src/consensus/gate_registry');
const { freshAirdrop } = require('./helpers/airdrop_fixtures.js');

const ENV = 'XC_AIRDROP_ZERO_LEGS_OMITTED_REGTEST_ACTIVATION';
const KEY = 'airdrop_zero_legs_omitted_activation.AIRDROP_ZERO_LEGS_OMITTED_ACTIVATION';
const RECIPIENT = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';

async function runAirdrop(network, blockIndex, amount = '0') {
    const { indexer, handler } = freshAirdrop();
    indexer.config.NETWORK = network;
    indexer.config.COIN = 'BTC';
    indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({
        TICK: 'TEST', TICK_ID: 1, DECIMALS: 0, SUPPLY: '100000',
    }));
    indexer.indexerDb.getListType.resolves(2);
    indexer.indexerDb.getList.resolves([RECIPIENT]);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '100000' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.isActionAllowed.resolves(true);
    const ledger = sinon.spy(indexer.util, 'processTransactionLedgerChanges');

    const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0, BLOCK_INDEX: blockIndex });
    await handler.parse(['0', 'TEST', amount, '1', null], data, null);
    const call = ledger.lastCall;
    return { data, credits: call.args[2], debits: call.args[3] };
}

function tokenLegs(rows) {
    return rows.filter((row) => row[0] === 'TEST');
}

function exactTokenLegs(rows) {
    return tokenLegs(rows).map((row) => [row[0], String(row[1]), row[2]]);
}

describe('AIRDROP zero ledger-leg activation @regression @tier1', function () {
    afterEach(function () {
        delete process.env[ENV];
        sinon.restore();
    });

    it('keeps zero payer and recipient rows while regtest is unarmed', async function () {
        delete process.env[ENV];
        const result = await runAirdrop('regtest', 100);
        assert.strictEqual(result.data.STATUS, 'valid');
        assert.deepStrictEqual(exactTokenLegs(result.debits), [['TEST', '0', result.data.SOURCE]]);
        assert.deepStrictEqual(exactTokenLegs(result.credits), [['TEST', '0', RECIPIENT]]);
    });

    it('omits zero payer and recipient rows when the new regtest gate is armed', async function () {
        process.env[ENV] = 'armed';
        const result = await runAirdrop('regtest', 100);
        assert.strictEqual(result.data.STATUS, 'valid');
        assert.deepStrictEqual(tokenLegs(result.debits), []);
        assert.deepStrictEqual(tokenLegs(result.credits), []);
        assert.deepStrictEqual(result.debits.concat(result.credits).filter((row) => String(row[1]) === '0'), []);
    });

    it('switches row creation exactly at the configured height boundary', async function () {
        process.env[ENV] = '100';
        const below = await runAirdrop('regtest', 99);
        sinon.restore();
        const at = await runAirdrop('regtest', 100);
        assert.deepStrictEqual(exactTokenLegs(below.debits), [['TEST', '0', below.data.SOURCE]]);
        assert.deepStrictEqual(exactTokenLegs(below.credits), [['TEST', '0', RECIPIENT]]);
        assert.deepStrictEqual(tokenLegs(at.debits), []);
        assert.deepStrictEqual(tokenLegs(at.credits), []);
    });

    it('stays byte-compatible on mainnet and testnet when the regtest lever is armed', async function () {
        process.env[ENV] = 'armed';
        const mainnet = await runAirdrop('mainnet', 5000000);
        sinon.restore();
        const testnet = await runAirdrop('testnet', 5000000);
        assert.deepStrictEqual(exactTokenLegs(mainnet.debits), [['TEST', '0', mainnet.data.SOURCE]]);
        assert.deepStrictEqual(exactTokenLegs(mainnet.credits), [['TEST', '0', RECIPIENT]]);
        assert.deepStrictEqual(exactTokenLegs(testnet.debits), [['TEST', '0', testnet.data.SOURCE]]);
        assert.deepStrictEqual(exactTokenLegs(testnet.credits), [['TEST', '0', RECIPIENT]]);
    });

    it('keeps positive payer and recipient rows above activation', async function () {
        process.env[ENV] = 'armed';
        const result = await runAirdrop('regtest', 100, '7');
        assert.deepStrictEqual(exactTokenLegs(result.debits), [['TEST', '7', result.data.SOURCE]]);
        assert.deepStrictEqual(exactTokenLegs(result.credits), [['TEST', '7', RECIPIENT]]);
    });

    it('publishes an unarmed public-network table and an opt-in regtest row', function () {
        delete process.env[ENV];
        for(const network of ['mainnet', 'testnet', 'regtest'])
            assert.strictEqual(gateRegistry.activeAt(KEY, network, 'BTC', 5000000, null), false, network);
        process.env[ENV] = 'armed';
        assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'mainnet', 'BTC', 5000000, null), false);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', 'BTC', 5000000, null), false);
    });
});

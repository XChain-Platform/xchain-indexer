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
const { SOURCE, HOLDER1, HOLDER2, useDividendHarness } = require('./helpers/dividend_harness.js');

const ENV = 'XC_DIVIDEND_EMPTY_ALLOW_LIST_DENIES_REGTEST_ACTIVATION';
const KEY = 'dividend_empty_allow_list_denies_activation.DIVIDEND_EMPTY_ALLOW_LIST_DENIES_ACTIVATION';

let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

async function runEmptyAllowList(network, blockIndex, members = []) {
    indexer.config.NETWORK = network;
    indexer.config.COIN = 'BTC';
    const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
    const dividendInfo = createTokenInfo({
        TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: 5, BLOCK_LIST: null,
    });
    indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
    indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(dividendInfo);
    indexer.indexerDb.getList.resolves(members);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '1000' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
    indexer.indexerDb.isActionAllowed.resolves(true);
    if(typeof indexer.util.processTransactionLedgerChanges.restore !== 'function')
        sinon.spy(indexer.util, 'processTransactionLedgerChanges');

    const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE, BLOCK_INDEX: blockIndex });
    await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
    const ledger = indexer.util.processTransactionLedgerChanges.lastCall;
    const normalize = (rows) => rows
        .filter((row) => row[0] === 'DIVTOK')
        .map((row) => [row[0], String(row[1]), row[2]]);
    return {
        data,
        debit: String(indexer.indexerDb.createDividend.lastCall.args[0].DEBIT),
        credits: normalize(ledger.args[2]),
        debits: normalize(ledger.args[3]),
    };
}

describe('DIVIDEND empty allow-list activation @regression @tier1', function () {
    useDividendHarness(bind);

    afterEach(function () {
        delete process.env[ENV];
    });

    it('keeps the legacy fail-open payout while regtest is unarmed', async function () {
        delete process.env[ENV];
        const result = await runEmptyAllowList('regtest', 100);
        assert.strictEqual(result.data.STATUS, 'valid');
        assert.strictEqual(result.debit, '30');
        assert.deepStrictEqual(result.debits, [['DIVTOK', '30', SOURCE]]);
        assert.deepStrictEqual(result.credits, [
            ['DIVTOK', '10', HOLDER1],
            ['DIVTOK', '20', HOLDER2],
        ]);
    });

    it('denies every holder when the new regtest gate is armed', async function () {
        process.env[ENV] = 'armed';
        const result = await runEmptyAllowList('regtest', 100);
        assert.strictEqual(result.data.STATUS, 'valid');
        assert.strictEqual(result.debit, '0');
        assert.deepStrictEqual(result.debits, [['DIVTOK', '0', SOURCE]]);
        assert.deepStrictEqual(result.credits, []);
    });

    it('pays every holder when the attached reference is one the list validity gate rejects', async function () {
        process.env[ENV] = 'armed';
        const result = await runEmptyAllowList('regtest', 100, null);
        assert.strictEqual(result.data.STATUS, 'valid');
        assert.strictEqual(result.debit, '30');
        assert.deepStrictEqual(result.credits, [
            ['DIVTOK', '10', HOLDER1],
            ['DIVTOK', '20', HOLDER2],
        ]);
    });

    it('switches payout exactly at the configured height boundary', async function () {
        process.env[ENV] = '100';
        const below = await runEmptyAllowList('regtest', 99);
        const at = await runEmptyAllowList('regtest', 100);
        assert.deepStrictEqual(below.credits, [
            ['DIVTOK', '10', HOLDER1],
            ['DIVTOK', '20', HOLDER2],
        ]);
        assert.deepStrictEqual(at.credits, []);
    });

    it('stays fail-open on mainnet and testnet when the regtest lever is armed', async function () {
        process.env[ENV] = 'armed';
        const mainnet = await runEmptyAllowList('mainnet', 5000000);
        const testnet = await runEmptyAllowList('testnet', 5000000);
        assert.strictEqual(mainnet.debit, '30');
        assert.strictEqual(testnet.debit, '30');
        assert.deepStrictEqual(mainnet.credits, testnet.credits);
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

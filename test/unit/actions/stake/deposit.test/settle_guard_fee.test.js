'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');

const Deposit = require('../../../../../src/actions/deposit.js');

const SOURCE         = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const CONTRACT_INDEX = '7';

function makeData(overrides = {}) {
    return createBaseData({
        ACTION: 'DEPOSIT', FORMAT: 0, SOURCE,
        CONTRACT_ACTION_INDEX: CONTRACT_INDEX, TICK: 'TEST', AMOUNT: '10',
        ...overrides,
    });
}

function makeFixture(balance = '100') {
    const indexer = createMockIndexer();
    indexer.indexerDb.createDeposit = sinon.stub().resolves();
    indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
    indexer.indexerDb.getAddressBalances.resolves({ 1: balance });
    indexer.indexerDb.isActionAllowed.resolves(true);
    const actionsCtx = {
        config: indexer.config, util: indexer.util, mapper: indexer.mapper,
        decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
        protocolChanges: {
            isEnabled: sinon.stub().callsFake(async (name) => name !== 'CONTROLLER_CUSTODY_GUARD'),
        },
    };
    indexer.util.resetLists();
    return { indexer, handler: new Deposit(actionsCtx) };
}

function captureLedger(indexer) {
    return sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
}

function assertDepositLegs(call, indexer, data) {
    assert.deepStrictEqual(call.args, [
        indexer.indexerDb,
        data,
        [['TEST', '10', 'C:BTC:' + CONTRACT_INDEX]],
        [['TEST', '10', SOURCE]],
    ]);
}

describe('Deposit balance snapshot', function () {
    afterEach(function () { sinon.restore(); });

    it('returns the SOURCE balance after the valid AMOUNT debit', async function () {
        const { indexer, handler } = makeFixture();
        const result = await handler.validateTokenAndBalance(makeData(), null);

        assert.strictEqual(result.error, null);
        assert.strictEqual(indexer.util.bcformat(result.balances[1], 18), '90.000000000000000000');
    });

    it('returns the insufficient-funds error with the balance undebited', async function () {
        const { handler } = makeFixture('5');
        const result = await handler.validateTokenAndBalance(makeData(), null);

        assert.strictEqual(result.error, 'invalid: insufficient funds (TICK)');
        assert.deepStrictEqual(result.balances, { 1: '5' });
    });
});

describe('Deposit guard-fee settlement', function () {
    afterEach(function () { sinon.restore(); });

    it('adds a lone GAS debit to the two deposit legs', async function () {
        const { indexer, handler } = makeFixture();
        const ledger = captureLedger(indexer);
        const data = makeData();

        await handler.settleDeposit(data, 'valid', '0.002');

        assert.deepStrictEqual(ledger.firstCall.args, [
            indexer.indexerDb,
            data,
            [['TEST', '10', 'C:BTC:' + CONTRACT_INDEX]],
            [['TEST', '10', SOURCE], [indexer.config['GAS'], '0.002', SOURCE]],
        ]);
        assert.ok(indexer.util.getAddressesList()[SOURCE].includes(indexer.config['GAS']));
    });

    it("keeps today's deposit legs when the fee argument is absent", async function () {
        const { indexer, handler } = makeFixture();
        const ledger = captureLedger(indexer);
        const data = makeData();

        await handler.settleDeposit(data, 'valid');

        assertDepositLegs(ledger.firstCall, indexer, data);
    });

    it("keeps today's deposit legs when the fee is zero", async function () {
        const { indexer, handler } = makeFixture();
        const ledger = captureLedger(indexer);
        const data = makeData();

        await handler.settleDeposit(data, 'valid', 0);

        assertDepositLegs(ledger.firstCall, indexer, data);
    });

    it("keeps today's empty legs for an invalid status", async function () {
        const { indexer, handler } = makeFixture();
        const ledger = captureLedger(indexer);
        const data = makeData();

        await handler.settleDeposit(data, 'invalid: denied', '0.002');

        assert.deepStrictEqual(ledger.firstCall.args, [indexer.indexerDb, data, [], []]);
    });
});

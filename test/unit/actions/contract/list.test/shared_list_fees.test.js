'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { SOURCE, makeListContext: makeBaseListContext } = require('./helpers/list_context.js');
const gateRegistry = require('../../../../../src/consensus/gate_registry.js');

function makeListContext(){
    const context = makeBaseListContext();
    context.handler.formats[2] = 'VERSION|LIST_ACTION_INDEX|MEMO';
    context.handler.formatGates[2] = 'list_share_activation.LIST_SHARE_ACTIVATION';
    return context;
}

function listData(overrides = {}){
    return createBaseData({
        ACTION: 'LIST',
        FORMAT: 2,
        SOURCE,
        LIST_ACTION_INDEX: 7,
        TX_OUTPUTS: [],
        ...overrides,
    });
}

function fundFee(indexer, amount = '10'){
    indexer.indexerDb.getAddressBalances.resolves({ 1: amount });
}

describe('LIST shared-list fees @regression @tier3', function () {
    beforeEach(function () {
        sinon.stub(gateRegistry, 'activeAt').returns(true);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('does not read or charge below LIST_SHARE_ACTIVATION', async function () {
        const { indexer, handler } = makeListContext();
        gateRegistry.activeAt.returns(false);

        const result = await handler.chargeFee(listData({ BLOCK_INDEX: 99 }), 1, 3, null);

        assert.deepStrictEqual(result, { error: null, fees: null });
        sinon.assert.notCalled(indexer.indexerDb.doQuery);
        sinon.assert.notCalled(indexer.indexerDb.getAddressBalances);
        sinon.assert.notCalled(indexer.indexerDb.getAddressPreferences);
    });

    it('does not charge or read fee state for an errored action', async function () {
        const { indexer, handler } = makeListContext();

        const result = await handler.chargeFee(listData(), 2, 0, 'invalid: ITEM');

        assert.deepStrictEqual(result, { error: 'invalid: ITEM', fees: null });
        sinon.assert.notCalled(gateRegistry.activeAt);
        sinon.assert.notCalled(indexer.indexerDb.doQuery);
        sinon.assert.notCalled(indexer.indexerDb.getAddressBalances);
    });

    it('prices SHARE at 1.00000000 XCHAIN', async function () {
        const { indexer, handler } = makeListContext();
        fundFee(indexer);

        const result = await handler.chargeFee(listData(), 2, 4, null);

        assert.strictEqual(result.error, null);
        assert.strictEqual(result.fees.GAS_COST, 100000);
        assert.strictEqual(result.fees.AMOUNT.toFixed(8), '1.00000000');
        assert.strictEqual(result.fees.FEE_VERSION, 2);
    });

    it('prices three new members but not one re-added existing member', async function () {
        const { indexer, handler } = makeListContext();
        indexer.indexerDb.doQuery.resolves([{ shared: 1 }]);
        fundFee(indexer);
        const current = new Set(['existing']);
        const wireItems = ['new-1', 'new-2', 'existing', 'new-3'];
        const changes = wireItems.filter((item) => !current.has(item)).length;

        const result = await handler.chargeFee(listData({ FORMAT: 1 }), 1, changes, null);

        assert.strictEqual(changes, 3);
        assert.strictEqual(result.error, null);
        assert.strictEqual(result.fees.GAS_COST.toString(), '5300');
        assert.strictEqual(result.fees.AMOUNT.toFixed(8), '0.05300000');
    });

    it('leaves a local-list edit free', async function () {
        const { indexer, handler } = makeListContext();
        indexer.indexerDb.doQuery.resolves([]);

        const result = await handler.chargeFee(listData({ FORMAT: 1 }), 1, 3, null);

        assert.deepStrictEqual(result, { error: null, fees: null });
        sinon.assert.notCalled(indexer.indexerDb.getAddressBalances);
        sinon.assert.notCalled(indexer.indexerDb.getAddressPreferences);
    });

    it('leaves an injected genesis edit free without fee reads', async function () {
        const { indexer, handler } = makeListContext();

        const result = await handler.chargeFee(
            listData({ FORMAT: 1, IS_GENESIS: true }), 1, 3, null
        );

        assert.deepStrictEqual(result, { error: null, fees: null });
        sinon.assert.notCalled(gateRegistry.activeAt);
        sinon.assert.notCalled(indexer.indexerDb.doQuery);
        sinon.assert.notCalled(indexer.indexerDb.getAddressBalances);
    });

    for(const preference of [
        { value: 1, label: 'destroys' },
        { value: 0, label: 'donates' },
    ]){
        it(preference.label + ' a BTC XCHAIN-balance fee according to preference', async function () {
            const { indexer, handler } = makeListContext();
            fundFee(indexer);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: preference.value });

            const data = listData();
            const result = await handler.chargeFee(data, 2, 0, null);
            await handler.settleFee(data, result.fees);

            assert.strictEqual(result.error, null);
            sinon.assert.calledOnce(indexer.indexerDb.createDebit);
            const debit = indexer.indexerDb.createDebit.firstCall.args;
            assert.strictEqual(debit[0], data.ACTION_INDEX);
            assert.strictEqual(debit[1], 'XCHAIN');
            assert.strictEqual(debit[2].toFixed(8), '1.00000000');
            assert.strictEqual(debit[3], SOURCE);
            sinon.assert.calledOnceWithExactly(indexer.indexerDb.createFeeRecord, result.fees);
            if(preference.value === 1){
                sinon.assert.notCalled(indexer.indexerDb.createCredit);
            } else {
                sinon.assert.calledOnce(indexer.indexerDb.createCredit);
                const credit = indexer.indexerDb.createCredit.firstCall.args;
                assert.strictEqual(credit[0], data.ACTION_INDEX);
                assert.strictEqual(credit[1], 'XCHAIN');
                assert.strictEqual(credit[2].toFixed(8), '1.00000000');
                assert.strictEqual(credit[3], handler.config.ADDRESS.DONATE1);
            }
            sinon.assert.calledOnceWithExactly(indexer.indexerDb.updateBalances, sinon.match.array);
            sinon.assert.calledOnceWithExactly(indexer.indexerDb.updateTokens, ['XCHAIN']);
        });
    }

    it('refuses a BTC XCHAIN-balance fee when the balance is insufficient', async function () {
        const { indexer, handler } = makeListContext();
        fundFee(indexer, '0.99999999');

        const result = await handler.chargeFee(listData(), 2, 0, null);

        assert.strictEqual(result.error, 'invalid: insufficient funds (FEE)');
    });

    for(const coin of ['LTC', 'DOGE']){
        it('accepts a ' + coin + ' native fee output', async function () {
            const { indexer, handler } = makeListContext();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true,
                nativeCoinAmount: '0.01',
                nativeCoin: coin,
                oracleRound: 8,
            });

            const result = await handler.chargeFee(listData({ COIN: coin }), 2, 0, null);

            assert.strictEqual(result.error, null);
            assert.strictEqual(result.fees.PAYMENT_MODE, 1);
            assert.strictEqual(result.fees.NATIVE_COIN, coin);
            assert.strictEqual(result.fees.NATIVE_COIN_AMOUNT, '0.01');
            assert.strictEqual(result.fees.ORACLE_ROUND, 8);
        });

        it('refuses a missing ' + coin + ' native fee output', async function () {
            const { indexer, handler } = makeListContext();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');

            const result = await handler.chargeFee(listData({ COIN: coin }), 2, 0, null);

            assert.strictEqual(
                result.error,
                'invalid: insufficient fee (native coin output required)'
            );
        });

        it('refuses an under-minimum ' + coin + ' native fee output', async function () {
            const { indexer, handler } = makeListContext();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: false,
                error: 'native coin fee below minimum',
            });

            const result = await handler.chargeFee(listData({ COIN: coin }), 2, 0, null);

            assert.strictEqual(result.error, 'invalid: native coin fee below minimum');
        });
    }

    it('carries the shared-list gas keys in every vendored coin bundle', function () {
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const schedule = require('../../../../../src/coins/' + coin + '.js').GAS_SCHEDULE;
            assert.strictEqual(schedule.LIST_SHARE, 100000, coin);
            assert.strictEqual(schedule.LIST_SHARED_EDIT_BASE, 5000, coin);
            assert.strictEqual(schedule.LIST_SHARED_EDIT_PER_ITEM, 100, coin);
        }
    });
});

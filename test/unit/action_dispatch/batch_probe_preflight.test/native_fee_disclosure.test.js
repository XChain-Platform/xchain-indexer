'use strict';

const assert = require('assert');
const Utility = require('../../../../src/utility.js');
const { readDryRunVerdict } = require('../../../../src/actions/actions_class/dry_run_support.js');

describe('BATCH native fee disclosure @regression @tier1', function () {
    it('lazily sums two ORDER native fees without changing BATCH_VALUE_LEDGER', async function () {
        let util = new Utility();
        util.config.COIN = 'DOGE';
        util.config.ADDRESS = Object.assign({}, util.config.ADDRESS, { FEE_DESTINATION: 'fee' });
        util.config.FEE_TOLERANCE_MIN = '0.95';
        let data = { FEE_PROBE: true, BATCH_POSITION: 0, BLOCK_INDEX: 1,
            BLOCK_TIME: 1000, BATCH_VALUE_LEDGER: { nativeFeeConsumed: '0', coinAmountConsumed: '0' } };
        let db = { getLatestPrice: async pair => ({ price: pair === 'XCHAIN/USD' ? '1' : '0.1', roundNumber: 1 }) };
        for(let i = 0; i < 2; i++)
            assert.strictEqual((await util.validateNativeCoinFee(data, { AMOUNT: '0.5' }, db,
                [{ address: 'fee', value: '100' }])).valid, true);
        assert.strictEqual(util.probePaymentDisclosure(data).nativeFeeOwed, '10.00000000');
        assert.deepStrictEqual(data.BATCH_VALUE_LEDGER, { nativeFeeConsumed: '0', coinAmountConsumed: '0' });
    });

    it('reports zero for a batch with no native fee and never invents it for a non-batch', async function () {
        let batchVerdict = {};
        let util = new Utility();
        await readDryRunVerdict({ _primaryVerdict: null, indexerDb: {}, util },
            { STATUS: 'valid', FEE_PROBE: true, BATCH_POSITION: 0 }, batchVerdict);
        assert.strictEqual(batchVerdict.nativeFeeOwed, '0');

        let plainVerdict = {};
        await readDryRunVerdict({ _primaryVerdict: null, indexerDb: {}, util },
            { STATUS: 'valid' }, plainVerdict);
        assert.strictEqual(plainVerdict.nativeFeeOwed, undefined);
    });
});

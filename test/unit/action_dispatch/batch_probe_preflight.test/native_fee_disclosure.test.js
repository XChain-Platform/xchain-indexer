'use strict';

const assert = require('assert');
const Utility = require('../../../../src/utility.js');

describe('BATCH native fee disclosure @regression @tier1', function () {
    it('sums two ORDER native fees without changing BATCH_VALUE_LEDGER', async function () {
        let util = new Utility();
        util.config.COIN = 'DOGE';
        util.config.ADDRESS = Object.assign({}, util.config.ADDRESS, { FEE_DESTINATION: 'fee' });
        util.config.FEE_TOLERANCE_MIN = '0.95';
        let data = { FEE_PROBE: true, PROBE_NATIVE_FEE_OWED: '0', BLOCK_INDEX: 1,
            BLOCK_TIME: 1000, BATCH_VALUE_LEDGER: { nativeFeeConsumed: '0', coinAmountConsumed: '0' } };
        let db = { getLatestPrice: async pair => ({ price: pair === 'XCHAIN/USD' ? '1' : '0.1', roundNumber: 1 }) };
        for(let i = 0; i < 2; i++)
            assert.strictEqual((await util.validateNativeCoinFee(data, { AMOUNT: '0.5' }, db,
                [{ address: 'fee', value: '100' }])).valid, true);
        assert.strictEqual(data.PROBE_NATIVE_FEE_OWED, '10.00000000');
        assert.deepStrictEqual(data.BATCH_VALUE_LEDGER, { nativeFeeConsumed: '0', coinAmountConsumed: '0' });
    });
});

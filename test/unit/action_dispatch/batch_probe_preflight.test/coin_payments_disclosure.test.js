'use strict';

const assert = require('assert');
const pricing = require('../../../../src/actions/dispense/pricing.js');

describe('BATCH coin payment disclosure @regression @tier1', function () {
    it('sums two DISPENSE costs without changing BATCH_VALUE_LEDGER', async function () {
        let data = { FEE_PROBE: true, COIN_DESTINATION: 'dispense',
            PROBE_COIN_PAYMENTS_OWED: {},
            BATCH_VALUE_LEDGER: { nativeFeeConsumed: '0', coinAmountConsumed: '0' } };
        let ctx = { data, ledger: null, tallyScale: 8 };
        let host = { util: {
            isNull: v => v === null || v === undefined,
            bcmul: (a, b) => (Number(a) * Number(b)).toFixed(8),
            bcadd: (a, b) => (Number(a) + Number(b)).toFixed(8),
            bcformat: v => Number(v).toFixed(8)
        }};
        for(let i = 0; i < 2; i++)
            await pricing.drainDispenseTally.call(host, ctx,
                { dispenser: {}, multiplier: 1, unitCoinCost: '1.25', error: false, available: '10' });
        assert.deepStrictEqual(data.PROBE_COIN_PAYMENTS_OWED, { dispense: '2.50000000' });
        assert.deepStrictEqual(data.BATCH_VALUE_LEDGER, { nativeFeeConsumed: '0', coinAmountConsumed: '0' });
    });
});

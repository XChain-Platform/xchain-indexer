'use strict';

const assert = require('assert');
const Utility = require('../../../../src/utility.js');
const paymentPool = require('../../../../src/actions/coinpay/payment_pool.js');

describe('BATCH coin payment disclosure @regression @tier1', function () {
    it('sums valid COINPAY obligations by payee without requiring payment outputs', async function () {
        let data = { FEE_PROBE: true, BATCH_POSITION: 0, COIN_DESTINATION: null,
            BATCH_VALUE_LEDGER: { nativeFeeConsumed: '0', coinAmountConsumed: '0' } };
        let host = { util: new Utility(), openBatchLedger: paymentPool.openBatchLedger };
        let obligations = [
            { PAYEE_ADDRESS: 'seller-a', COIN_AMOUNT: '1.25000000' },
            { PAYEE_ADDRESS: 'seller-a', COIN_AMOUNT: '0.75000000' },
            { PAYEE_ADDRESS: 'seller-b', COIN_AMOUNT: '3.00000000' }
        ];
        for(let obligation of obligations){
            let pool = await paymentPool.resolvePaymentPool.call(host, data, obligation);
            assert.ok(pool, 'the probe must price an obligation without a payment output');
            paymentPool.drawFromPool.call(host, pool, obligation, 'valid');
        }
        assert.deepStrictEqual(host.util.probePaymentDisclosure(data).coinPaymentsOwed, {
            'seller-a': '2.00000000',
            'seller-b': '3.00000000'
        });
        assert.deepStrictEqual(data.BATCH_VALUE_LEDGER, { nativeFeeConsumed: '0', coinAmountConsumed: '0' });
    });

    it('does not disclose an obligation whose later validity check rejects it', async function () {
        let data = { FEE_PROBE: true, BATCH_POSITION: 0,
            BATCH_VALUE_LEDGER: { nativeFeeConsumed: '0', coinAmountConsumed: '0' } };
        let host = { util: new Utility(), openBatchLedger: paymentPool.openBatchLedger };
        let obligation = { PAYEE_ADDRESS: 'expired-seller', COIN_AMOUNT: '9.00000000' };
        let pool = await paymentPool.resolvePaymentPool.call(host, data, obligation);
        paymentPool.drawFromPool.call(host, pool, obligation, 'invalid: COINPAY obligation expired');
        assert.deepStrictEqual(host.util.probePaymentDisclosure(data).coinPaymentsOwed, {});
    });
});

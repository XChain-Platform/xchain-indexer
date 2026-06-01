const assert = require('assert');

// Utility loads coin config in its constructor from these env vars.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../src/utility.js');

const FEE_DEST     = 'feeDestinationAddr111111111111111';
const PLACEHOLDER  = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

// Build a Utility instance with a known fee destination + tolerance/oracle config.
function makeUtil(coin, feeDestination){
    let util = new Utility();
    util.config['COIN']                        = coin;
    util.config['ADDRESS']                     = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: feeDestination });
    util.config['FEE_TOLERANCE_MIN']           = '0.95';
    util.config['FEE_TOLERANCE_MAX']           = '1.10';
    util.config['ORACLE_MAX_PRICE_AGE_SECONDS']= 1800;
    return util;
}

// Stub DB exposing getLatestPrice(pair). `prices` maps pair -> decimal string (or null = stale/missing).
function priceStub(prices){
    return {
        getLatestPrice: async (pair) => {
            if(!(pair in prices) || prices[pair] == null)
                return null;
            return { price: prices[pair], roundNumber: 7, block_timestamp: 1000 };
        }
    };
}

const DATA = { BLOCK_INDEX: 100, BLOCK_TIME: 1000, COIN: 'DOGE' };

describe('native coin fee @regression @tier1', function () {

    describe('validateNativeCoinFee()', function () {

        it('accepts a correct fee: 0.5 XCHAIN @ $1.00, DOGE @ $0.10 => 5.0 DOGE', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let db   = priceStub({ 'XCHAIN/USD': '1.00000000', 'DOGE/USD': '0.10000000' });
            let out  = [{ address: FEE_DEST, value: '5.00000000' }];
            let r = await util.validateNativeCoinFee(DATA, { AMOUNT: '0.5' }, db, out);
            assert.strictEqual(r.valid, true);
            assert.strictEqual(r.nativeCoin, 'DOGE');
            assert.strictEqual(r.expectedAmount, '5.00000000');
            assert.strictEqual(r.nativeCoinAmount, '5.00000000');
            assert.strictEqual(r.oracleRound, 7);
        });

        it('accepts payment exactly at the lower tolerance bound (0.95x = 4.75)', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let db   = priceStub({ 'XCHAIN/USD': '1.00000000', 'DOGE/USD': '0.10000000' });
            let r = await util.validateNativeCoinFee(DATA, { AMOUNT: '0.5' }, db, [{ address: FEE_DEST, value: '4.75000000' }]);
            assert.strictEqual(r.valid, true);
        });

        it('rejects payment just below the lower tolerance bound', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let db   = priceStub({ 'XCHAIN/USD': '1.00000000', 'DOGE/USD': '0.10000000' });
            let r = await util.validateNativeCoinFee(DATA, { AMOUNT: '0.5' }, db, [{ address: FEE_DEST, value: '4.74999999' }]);
            assert.strictEqual(r.valid, false);
            assert.ok(/insufficient native coin fee/.test(r.error), r.error);
        });

        it('rejects when the COIN/USD price is missing or stale (getLatestPrice -> null)', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let db   = priceStub({ 'XCHAIN/USD': '1.00000000', 'DOGE/USD': null });
            let r = await util.validateNativeCoinFee(DATA, { AMOUNT: '0.5' }, db, [{ address: FEE_DEST, value: '5.00000000' }]);
            assert.strictEqual(r.valid, false);
            assert.ok(/DOGE\/USD .*(missing or stale)/.test(r.error), r.error);
        });

        it('rejects when the XCHAIN/USD price is missing or stale', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let db   = priceStub({ 'XCHAIN/USD': null, 'DOGE/USD': '0.10000000' });
            let r = await util.validateNativeCoinFee(DATA, { AMOUNT: '0.5' }, db, [{ address: FEE_DEST, value: '5.00000000' }]);
            assert.strictEqual(r.valid, false);
            assert.ok(/XCHAIN\/USD .*(missing or stale)/.test(r.error), r.error);
        });

        it('rejects an invalid (<= 0) oracle price', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let db   = priceStub({ 'XCHAIN/USD': '1.00000000', 'DOGE/USD': '0' });
            let r = await util.validateNativeCoinFee(DATA, { AMOUNT: '0.5' }, db, [{ address: FEE_DEST, value: '5.00000000' }]);
            assert.strictEqual(r.valid, false);
            assert.ok(/invalid oracle price for DOGE\/USD/.test(r.error), r.error);
        });

        it('rejects when no output pays the fee destination', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let db   = priceStub({ 'XCHAIN/USD': '1.00000000', 'DOGE/USD': '0.10000000' });
            let r = await util.validateNativeCoinFee(DATA, { AMOUNT: '0.5' }, db, [{ address: 'someoneElse', value: '5.00000000' }]);
            assert.strictEqual(r.valid, false);
            assert.ok(/no fee output to FEE_DESTINATION/.test(r.error), r.error);
        });

        it('accepts immediately when the XCHAIN fee is zero (no fee owed)', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let db   = priceStub({});
            let r = await util.validateNativeCoinFee(DATA, { AMOUNT: '0' }, db, [{ address: FEE_DEST, value: '0.00000001' }]);
            assert.strictEqual(r.valid, true);
            assert.strictEqual(r.nativeCoinAmount, '0');
        });

        it('reads the BTC/USD pair when COIN is BTC', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            // 1.0 XCHAIN @ $1.00, BTC @ $50,000 => 0.00002 BTC
            let db   = priceStub({ 'XCHAIN/USD': '1.00000000', 'BTC/USD': '50000.00000000' });
            let r = await util.validateNativeCoinFee({ BLOCK_INDEX: 100, BLOCK_TIME: 1000, COIN: 'BTC' }, { AMOUNT: '1.0' }, db, [{ address: FEE_DEST, value: '0.00002000' }]);
            assert.strictEqual(r.valid, true);
            assert.strictEqual(r.expectedAmount, '0.00002000');
        });
    });

    describe('detectFeePaymentMode()', function () {

        it('returns "xchain" when FEE_DESTINATION is the unset placeholder', function () {
            let util = makeUtil('DOGE', PLACEHOLDER);
            let mode = util.detectFeePaymentMode({ COIN: 'DOGE' }, null, [{ address: FEE_DEST, value: '5' }]);
            assert.strictEqual(mode, 'xchain');
        });

        it('returns "native" when an output pays the fee destination', function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let mode = util.detectFeePaymentMode({ COIN: 'DOGE' }, null, [{ address: FEE_DEST, value: '5' }]);
            assert.strictEqual(mode, 'native');
        });

        it('BTC with no fee output falls back to "xchain"', function () {
            let util = makeUtil('BTC', FEE_DEST);
            let mode = util.detectFeePaymentMode({ COIN: 'BTC' }, null, [{ address: 'change', value: '1' }]);
            assert.strictEqual(mode, 'xchain');
        });

        it('LTC/DOGE with no fee output are "rejected"', function () {
            for(let coin of ['LTC', 'DOGE']){
                let util = makeUtil(coin, FEE_DEST);
                let mode = util.detectFeePaymentMode({ COIN: coin }, null, [{ address: 'change', value: '1' }]);
                assert.strictEqual(mode, 'rejected', coin);
            }
        });

        it('treats undefined txOutputs as no fee output (the live-pipeline default before the fix)', function () {
            let util = makeUtil('BTC', FEE_DEST);
            assert.strictEqual(util.detectFeePaymentMode({ COIN: 'BTC' }, null, undefined), 'xchain');
            let dutil = makeUtil('DOGE', FEE_DEST);
            assert.strictEqual(dutil.detectFeePaymentMode({ COIN: 'DOGE' }, null, undefined), 'rejected');
        });
    });
});

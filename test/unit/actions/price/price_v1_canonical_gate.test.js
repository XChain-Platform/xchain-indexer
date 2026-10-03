'use strict';

const assert = require('assert');

const { createMockIndexer } = require('../../../fixtures/mocks');
const Price = require('../../../../src/actions/price/index.js');
const { validatePriceV1 } = require('../../../../src/actions/price/v1.js');
const priceScale = require('../../../../src/consensus/gates/price_scale_gate.js');

const handler = new Price(createMockIndexer());

function validate(network, value, fee, data = { BLOCK_TIME: 1790000000 }, indexerCoin){
    const config = { ...handler.config, NETWORK: network };
    if(indexerCoin) config.COIN = indexerCoin;
    const coin   = config.COINS[0];
    const fiat   = Object.keys(config.FIATS)[0];
    const params = ['1', coin, 'GOLD', fiat, value, fee, ''];
    return validatePriceV1(config, handler.util, params, data, null);
}

describe('PRICE v1 canonical gate overflow witness', function () {
    const value = '0'.repeat(297) + '1.5';
    const fee   = '0'.repeat(297) + '0.5';

    for(const network of ['mainnet', 'testnet']){
        it(`accepts 300-character VALUE and FEE on ${network}`, function () {
            assert.strictEqual(value.length, 300);
            assert.strictEqual(fee.length, 300);
            assert.strictEqual(validate(network, value, fee), null);
        });
    }
});

describe('PRICE v1 canonical gate honest values', function () {
    const fees = [
        ['0', 'FEE 0'],
        ['0.01', 'FEE 0.01'],
        ['1', 'FEE 1'],
        ['', 'no FEE'],
    ];

    for(const network of ['mainnet', 'testnet', 'regtest']){
        for(const [fee, label] of fees){
            it(`accepts VALUE 12345.12345678 with ${label} on ${network}`, function () {
                assert.strictEqual(validate(network, '12345.12345678', fee), null);
            });
        }
    }
});

describe('PRICE v1 canonical gate armed on regtest', function () {
    const overlongValue = '1'.repeat(priceScale.PRICE_V1_VALUE_MAX_LENGTH + 1);
    const overlongFee   = '0'.repeat(priceScale.PRICE_V1_FEE_MAX_LENGTH - 2) + '0.5';
    const cases = [
        ['01.5', '0.5', 'invalid: VALUE (format)', 'leading-zero VALUE'],
        ['1.5', '00.5', 'invalid: FEE (format)', 'leading-zero FEE'],
        [overlongValue, '0.5', 'invalid: VALUE (format)', 'VALUE one character over its cap'],
        ['1.5', overlongFee, 'invalid: FEE (format)', 'FEE one character over its cap'],
    ];

    for(const [value, fee, reason, label] of cases){
        it(`rejects ${label}`, function () {
            assert.strictEqual(validate('regtest', value, fee), reason);
        });
    }
});

describe('PRICE v1 canonical gate fail-closed time', function () {
    it('uses the legacy rule when BLOCK_TIME is missing', function () {
        const value = '0'.repeat(297) + '1.5';
        const fee   = '0'.repeat(297) + '0.5';
        assert.strictEqual(validate('regtest', value, fee, {}), null);
    });
});

describe('PRICE v1 canonical gate post-arm coin thresholds', function () {
    const instant = 1791039938;
    const unarmed = 9999999999;
    const saved = {};

    beforeEach(function () {
        const table = priceScale.PRICE_V1_CANONICAL_ACTIVATION;
        for(const key of Object.keys(table)) saved[key] = table[key];
        table.testnet = unarmed;
        for(const coin of ['BTC', 'LTC', 'DOGE']) table[coin + ':testnet'] = instant;
    });

    afterEach(function () {
        const table = priceScale.PRICE_V1_CANONICAL_ACTIVATION;
        for(const key of Object.keys(table)) delete table[key];
        Object.assign(table, saved);
        for(const key of Object.keys(saved)) delete saved[key];
    });

    for(const coin of ['BTC', 'LTC', 'DOGE']){
        it('activates ' + coin + ' exactly at its armed testnet instant', function () {
            const value = '0'.repeat(297) + '1.5';
            const fee = '0'.repeat(297) + '0.5';
            assert.strictEqual(validate('testnet', value, fee,
                { BLOCK_TIME: instant - 1 }, coin), null);
            assert.strictEqual(validate('testnet', value, fee,
                { BLOCK_TIME: instant }, coin), 'invalid: VALUE (format)');
        });
    }
});

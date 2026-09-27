'use strict';

const assert = require('assert');

const { createMockIndexer } = require('../../../fixtures/mocks');
const Price = require('../../../../src/actions/price/index.js');
const { validatePriceV1 } = require('../../../../src/actions/price/v1.js');

const handler = new Price(createMockIndexer());

function validate(network, value, fee){
    const config = { ...handler.config, NETWORK: network };
    const coin   = config.COINS[0];
    const fiat   = Object.keys(config.FIATS)[0];
    const params = ['1', coin, 'GOLD', fiat, value, fee, ''];
    const data   = { BLOCK_TIME: 1790000000 };
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

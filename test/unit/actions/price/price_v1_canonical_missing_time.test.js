'use strict';

const assert = require('assert');

const Price = require('../../../../src/actions/price/index.js');
const { validatePriceV1 } = require('../../../../src/actions/price/v1.js');
const { createMockIndexer } = require('../../../fixtures/mocks');

const LEGACY_CASES = [
    { name: 'leading-zero VALUE', value: '0012.5', fee: '' },
    { name: 'leading-zero FEE', value: '12.5', fee: '00.5' },
    { name: 'VALUE one over the canonical cap', value: '12345678901.1234567', fee: '' },
    { name: 'very long VALUE and FEE', value: '0'.repeat(297) + '1.5', fee: '0'.repeat(297) + '0.5' },
];

describe('PRICE v1 canonical bound with no BLOCK_TIME falls back to the legacy rule', function () {
    const handler = new Price(createMockIndexer());

    for(const network of ['mainnet', 'testnet', 'regtest']){
        for(const testCase of LEGACY_CASES){
            it(network + ' accepts ' + testCase.name, function () {
                const config = Object.assign({}, handler.config, { NETWORK: network });
                const coin = config.COINS[0];
                const fiat = Object.keys(config.FIATS)[0];
                const params = ['1', coin, 'GOLD', fiat, testCase.value, testCase.fee, ''];
                const data = {};

                assert.strictEqual(Object.prototype.hasOwnProperty.call(data, 'BLOCK_TIME'), false);
                assert.strictEqual(validatePriceV1(config, handler.util, params, data, null), null);
            });
        }
    }
});

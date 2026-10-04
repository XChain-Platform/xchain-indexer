// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict';

const assert = require('assert');
const { applyCurrencies } = require('../../../src/config/currencies.js');

const EXPECTED_COINS = ['BTC', 'LTC', 'DOGE'];
const EXPECTED_FIATS = [
    'USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY',
    'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW'
];

describe('config currencies', function(){
    it('applies only the consensus coin and fiat currency lists', function(){
        const config = {};

        applyCurrencies(config);

        assert.deepStrictEqual(Object.keys(config), ['COINS', 'FIATS']);
        assert.deepStrictEqual(config.COINS, EXPECTED_COINS);
        assert.deepStrictEqual(Object.keys(config.FIATS), EXPECTED_FIATS);
        for(const name of Object.values(config.FIATS)){
            assert.strictEqual(typeof name, 'string');
            assert.notStrictEqual(name.trim(), '');
        }
    });

    it('produces an equal result when applied twice', function(){
        const config = {};
        applyCurrencies(config);
        const firstResult = JSON.parse(JSON.stringify(config));

        applyCurrencies(config);

        assert.deepStrictEqual(config, firstResult);
    });
});

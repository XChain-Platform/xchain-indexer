/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const assert = require('assert');
const { pickMaxPriceAgeSeconds } = require('../../../src/utility/price_age/pick.js');

describe('price age pick', function(){
    it('selects the standard value when the gate is off', function(){
        let config = {
            ORACLE_MAX_PRICE_AGE_SECONDS: 1800,
            ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS: 4500
        };
        assert.strictEqual(pickMaxPriceAgeSeconds(config, false), 1800);
        assert.strictEqual(pickMaxPriceAgeSeconds(config, 1), 1800);
    });

    it('selects the hourly value when the gate is on', function(){
        let config = {
            ORACLE_MAX_PRICE_AGE_SECONDS: 1800,
            ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS: 4500
        };
        assert.strictEqual(pickMaxPriceAgeSeconds(config, true), 4500);
    });

    it('falls back when the hourly key is missing', function(){
        assert.strictEqual(pickMaxPriceAgeSeconds({}, true), 1800);
    });

    it('parses a string value', function(){
        assert.strictEqual(pickMaxPriceAgeSeconds({ ORACLE_MAX_PRICE_AGE_SECONDS: '900' }, false), 900);
    });

    it('falls back when the selected value is zero', function(){
        assert.strictEqual(pickMaxPriceAgeSeconds({ ORACLE_MAX_PRICE_AGE_SECONDS: 0 }, false), 1800);
    });

    it('falls back for a null config', function(){
        assert.strictEqual(pickMaxPriceAgeSeconds(null, true), 1800);
    });
});

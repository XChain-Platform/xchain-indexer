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
const { maxPriceAgeSecondsAt } = require('../../../src/utility/oracle_price_age.js');

describe('price age at block', function(){
    const config = {
        ORACLE_MAX_PRICE_AGE_SECONDS: 1800,
        ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS: 4500
    };

    it('selects the hourly value for every regtest chain at activation', function(){
        for(const chainKey of ['BTC', 'LTC', 'DOGE'])
            assert.strictEqual(maxPriceAgeSecondsAt(config, 'regtest', chainKey, 0), 4500);
    });

    it('selects the standard value for every unarmed testnet chain', function(){
        for(const chainKey of ['BTC', 'LTC', 'DOGE'])
            assert.strictEqual(maxPriceAgeSecondsAt(config, 'testnet', chainKey, 1), 1800);
    });

    it('selects the standard value for unarmed mainnet', function(){
        assert.strictEqual(maxPriceAgeSecondsAt(config, 'mainnet', 'BTC', 9999999998), 1800);
    });

    it('falls back when the hourly key is missing at activation', function(){
        assert.strictEqual(maxPriceAgeSecondsAt({
            ORACLE_MAX_PRICE_AGE_SECONDS: 1800
        }, 'regtest', 'BTC', 0), 1800);
    });

    it('falls back for a null config at activation', function(){
        assert.strictEqual(maxPriceAgeSecondsAt(null, 'regtest', 'BTC', 0), 1800);
    });
});

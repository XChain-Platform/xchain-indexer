// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../../src/utility.js');

const prototypeNames = ['valueOf', 'constructor', 'toString', '__proto__'];

describe('addAddressTicker prototype-named keys @regression @tier1', function () {
    let util;

    beforeEach(function () {
        util = new Utility();
    });

    for(const address of prototypeNames){
        it('stores an own ticker list for address ' + address, function () {
            assert.doesNotThrow(function () {
                util.addAddressTicker(address, 'TEST');
            });
            assert.strictEqual(Object.prototype.hasOwnProperty.call(util.addresses, address), true);
            assert.deepStrictEqual(util.addresses[address], ['TEST']);
        });
    }

    for(const tick of prototypeNames){
        it('stores prototype-named ticker ' + tick + ' in an own address list', function () {
            const address = 'address-' + tick;
            assert.doesNotThrow(function () {
                util.addAddressTicker(address, tick);
            });
            assert.strictEqual(Object.prototype.hasOwnProperty.call(util.addresses, address), true);
            assert.deepStrictEqual(util.addresses[address], [tick]);
            assert.strictEqual(util.tickers.includes(tick), true);
        });
    }
});

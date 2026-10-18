'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

const registry = require('../../../src/consensus/gate_registry.js');

const KEY = 'active_stake_collation_activation.ACTIVE_STAKE_COLLATION_ACTIVATION';

describe('protocol_changes active-stake collation gate @regression @tier1', function () {
    it('registers a height gate unarmed on mainnet, armed on testnet at its v0.25.0 heights, and active from regtest genesis', function () {
        // The v0.25.0 cut arms BTC:testnet 157053, LTC:testnet 4928170, DOGE:testnet 68008790.
        const TESTNET = { BTC: 157053, LTC: 4928170, DOGE: 68008790 };
        assert.strictEqual(registry.registry.unitOf(KEY), 'height');
        assert.deepStrictEqual(registry.get(KEY), {
            mainnet: registry.UNARMED,
            'BTC:testnet': TESTNET.BTC,
            'LTC:testnet': TESTNET.LTC,
            'DOGE:testnet': TESTNET.DOGE,
            testnet: registry.UNARMED,
            regtest: 0,
        });

        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(registry.activeAt(KEY, 'mainnet', coin, 1e9, null), false, coin + ':mainnet');
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, TESTNET[coin] - 1, null), false, coin + ':testnet below');
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, TESTNET[coin], null), true, coin + ':testnet at');
        }
        assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', -1, null), false);
        assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });

    it('is inert when height is null or non-finite', function () {
        for (const height of [null, NaN, Infinity, -Infinity]) {
            assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', height, null), false,
                'height ' + String(height));
        }
    });
});

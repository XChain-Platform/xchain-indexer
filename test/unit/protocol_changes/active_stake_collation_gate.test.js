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
    it('registers a height gate unarmed on public networks and active from regtest genesis', function () {
        assert.strictEqual(registry.registry.unitOf(KEY), 'height');
        assert.deepStrictEqual(registry.get(KEY), {
            mainnet: registry.UNARMED,
            testnet: registry.UNARMED,
            regtest: 0,
        });

        for (const network of ['mainnet', 'testnet']) {
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                assert.strictEqual(registry.activeAt(KEY, network, coin, 1e9, null), false,
                    coin + ':' + network);
            }
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

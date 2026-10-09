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
const registry = require('../../../../src/consensus/gate_registry.js');

const KEY = 'vm_lint_optional_chain_heights.VM_LINT_OPTIONAL_CHAIN_ACTIVATION';
const UNARMED = 9999999999;

describe('protocol_changes VM lint optional-chain row', function () {
    it('registers the per-chain height map', function () {
        assert.strictEqual(registry.registry.unitOf(KEY), 'height');
        assert.deepStrictEqual(registry.get(KEY), {
            'BTC:mainnet': UNARMED,
            'LTC:mainnet': UNARMED,
            'DOGE:mainnet': UNARMED,
            'BTC:testnet': 155001,
            'LTC:testnet': 4906040,
            'DOGE:testnet': 67962387,
            testnet: UNARMED,
            regtest: 0,
        });
    });

    it('is active on regtest at genesis, unarmed on mainnet and armed at the v0.21.3 testnet heights', function () {
        assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(registry.activeAt(KEY, 'mainnet', coin, 10000000, null), false,
                coin + ':mainnet');
        }
        for (const [coin, height] of [['BTC', 155001], ['LTC', 4906040], ['DOGE', 67962387]]) {
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, height - 1, null), false, coin + ':testnet');
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, height, null), true, coin + ':testnet');
        }
    });
});

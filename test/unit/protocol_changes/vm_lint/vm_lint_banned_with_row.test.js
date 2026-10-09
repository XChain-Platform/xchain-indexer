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

const KEY = 'vm_lint_banned_with_heights.VM_LINT_BANNED_WITH_ACTIVATION';
const UNARMED = 9999999999;

describe('protocol_changes VM lint banned-with row', function () {
    it('registers the per-chain height map', function () {
        assert.strictEqual(registry.registry.unitOf(KEY), 'height');
        assert.deepStrictEqual(registry.get(KEY), {
            'BTC:mainnet': UNARMED,
            'LTC:mainnet': UNARMED,
            'DOGE:mainnet': UNARMED,
            'BTC:testnet': UNARMED,
            'LTC:testnet': UNARMED,
            'DOGE:testnet': UNARMED,
            testnet: UNARMED,
            regtest: 0,
        });
    });

    it('is active on regtest at genesis and unarmed on every mainnet and testnet chain', function () {
        assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        for (const network of ['mainnet', 'testnet']) {
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                assert.strictEqual(registry.activeAt(KEY, network, coin, 10000000, null), false,
                    coin + ':' + network);
            }
        }
    });
});

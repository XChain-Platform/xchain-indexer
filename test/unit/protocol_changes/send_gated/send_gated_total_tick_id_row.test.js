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

const KEY = 'send_gated_total_tick_id_activation.SEND_GATED_TOTAL_TICK_ID_ACTIVATION';
const UNARMED = 9999999999;

describe('protocol_changes SEND_GATED_TOTAL_TICK_ID row', function () {
    it('registers the per-network time map', function () {
        assert.strictEqual(registry.registry.unitOf(KEY), 'time');
        assert.deepStrictEqual(registry.get(KEY), {
            mainnet: UNARMED,
            testnet: UNARMED,
            'BTC:testnet': UNARMED,
            'LTC:testnet': UNARMED,
            'DOGE:testnet': UNARMED,
            regtest: 0,
        });
    });

    it('is active on regtest at genesis and inactive on every production network', function () {
        assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', 0, 0), true);
        for (const network of ['mainnet', 'testnet']) {
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                assert.strictEqual(registry.activeAt(KEY, network, coin, 1, 4000000000), false,
                    coin + ':' + network);
            }
        }
    });
});

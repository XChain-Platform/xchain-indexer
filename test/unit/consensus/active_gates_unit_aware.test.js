/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const assert = require('assert');
const registry = require('../../../src/consensus/gate_registry.js');
const { activeGatesAt } = require('../../../src/consensus_rules_digest.js');

describe('consensus rules digest activeGatesAt unit filtering', function () {
    it('excludes network-shaped constant rows from the responsible set', function () {
        const key = 'oracle_hourly_window_activation.ORACLE_HOURLY_WINDOW_FIRST_ROUND';
        assert.strictEqual(registry.registry.unitOf(key), 'constant');
        assert.strictEqual(registry.get(key).testnet, 5082);
        assert.ok(!activeGatesAt(5082, 'testnet').includes(key));
        assert.ok(!activeGatesAt(Number.MAX_SAFE_INTEGER, 'regtest').includes(key));
    });

    it('keeps height, time and epoch activation rows eligible', function () {
        const cases = [
            ['price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION', 'time'],
            ['rollcall_activation.ROLLCALL_ACTIVATION', 'epoch'],
            ['snapshot_reorg_buffer.SNAPSHOT_BURIAL_ACTIVATION', 'height'],
        ];
        const active = activeGatesAt(0, 'mainnet');
        for (const [key, unit] of cases) {
            assert.strictEqual(registry.registry.unitOf(key), unit, key);
            assert.ok(active.includes(key), key);
        }
    });

    it('keeps coin-qualified height resolution without a named coin', function () {
        const key = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';
        const table = registry.get(key);
        const first = Math.min(table['BTC:testnet'], table['LTC:testnet'], table['DOGE:testnet']);
        assert.ok(!activeGatesAt(first - 1, 'testnet').includes(key));
        assert.ok(activeGatesAt(first, 'testnet').includes(key));
    });
});

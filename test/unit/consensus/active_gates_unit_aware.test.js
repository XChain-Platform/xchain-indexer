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
const { activeGatesAt, ACTIVE_GATES_UNIT_FILTER_HEIGHTS } = require('../../../src/consensus_rules_digest.js');

describe('consensus rules digest activeGatesAt unit filtering', function () {
    it('excludes network-shaped constant rows from the responsible set', function () {
        const key = 'oracle_hourly_window_activation.ORACLE_HOURLY_WINDOW_FIRST_ROUND';
        assert.strictEqual(registry.registry.unitOf(key), 'constant');
        assert.strictEqual(registry.get(key).testnet, 5082);
        assert.ok(!activeGatesAt(156140, 'testnet').includes(key));
        assert.ok(!activeGatesAt(Number.MAX_SAFE_INTEGER, 'regtest').includes(key));
    });

    it('returns only activation-unit rows for every supported network and coin lookup', function () {
        const activationUnits = new Set(['height', 'time', 'epoch']);
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            for (const coin of [undefined, 'BTC', 'LTC', 'DOGE']) {
                for (const key of activeGatesAt(Number.MAX_SAFE_INTEGER, network, coin)) {
                    const unit = registry.registry.unitOf(key);
                    assert.ok(activationUnits.has(unit), key + ' has non-activation unit ' + unit);
                }
            }
        }
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

    it('applies the unit filter only at or above ACTIVE_GATES_UNIT_FILTER_HEIGHTS', function () {
        const key = 'oracle_hourly_window_activation.ORACLE_HOURLY_WINDOW_FIRST_ROUND';
        const H = ACTIVE_GATES_UNIT_FILTER_HEIGHTS;
        assert.deepStrictEqual(Object.assign({}, H), {
            'mainnet': 0, 'BTC:testnet': 156140, 'LTC:testnet': 4912553, 'DOGE:testnet': 67988245
        });
        assert.ok(!activeGatesAt(Number.MAX_SAFE_INTEGER, 'mainnet').includes(key));
        assert.ok(activeGatesAt(5082, 'testnet').includes(key));
        assert.ok(!activeGatesAt(156140, 'testnet').includes(key));
        assert.ok(activeGatesAt(5082, 'testnet', 'DOGE').includes(key));
        assert.ok(!activeGatesAt(67988245, 'testnet', 'DOGE').includes(key));
        assert.ok(activeGatesAt(156140, 'testnet', 'LTC').includes(key));
    });
});

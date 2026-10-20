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

// The v0.23.0 cut armed this row with one sized time per testnet chain. The values are read
// from the registry row, never repeated here, so the case grades the shape the arming train
// writes and the resolver at each chain's own boundary: dark at 1 and one short, live at it.
function armedTestnetSlots(row) {
    const slots = {};
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
        const v = row[coin + ':testnet'];
        assert.ok(Number.isInteger(v) && v > 1 && v < UNARMED, coin + ':testnet is not a sized time: ' + v);
        slots[coin + ':testnet'] = v;
    }
    return slots;
}

function assertArmedOnEachTestnetChain(key) {
    const slots = armedTestnetSlots(registry.get(key));
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
        const v = slots[coin + ':testnet'];
        const at = (n) => registry.activeAt(key, 'testnet', coin, 1, n);
        assert.strictEqual(at(1), false, coin + ':testnet at 1');
        assert.strictEqual(at(v - 1), false, coin + ':testnet one short of its activation');
        assert.strictEqual(at(v), true, coin + ':testnet at its activation');
    }
}

describe('protocol_changes SEND_GATED_TOTAL_TICK_ID row', function () {
    it('registers the per-network time map', function () {
        assert.strictEqual(registry.registry.unitOf(KEY), 'time');
        const row = registry.get(KEY);
        // A time gate arms one instant for the whole network, so the bare fallback carries it
        // and every chain agrees.
        assert.deepStrictEqual(row, {
            mainnet: UNARMED,
            testnet: row.testnet,
            ...armedTestnetSlots(row),
            regtest: 0,
        });
        for (const coin of ['BTC', 'LTC', 'DOGE']) assert.strictEqual(row[coin + ':testnet'], row.testnet, coin);
    });

    it('is active on regtest at genesis, inactive on every mainnet chain and armed on each testnet chain', function () {
        assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', 0, 0), true);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(registry.activeAt(KEY, 'mainnet', coin, 1, UNARMED - 1), false, coin + ':mainnet');
        }
        assertArmedOnEachTestnetChain(KEY);
    });
});

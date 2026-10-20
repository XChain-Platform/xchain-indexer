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
const fs = require('fs');
const path = require('path');

const ProtocolChanges = require('../../../src/protocol_changes.js');
const { REGISTRY_ONLY_STEMS } = require('../../helpers/gate_modules.js');

const KEY = 'cross_chain_offer_list_export_activation.CROSS_CHAIN_OFFER_LIST_EXPORT';
const PART = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes', 'gates_4.js');

// The v0.23.0 cut armed this row with one sized height per testnet chain. The values are read
// from the registry row, never repeated here, so the case grades the shape the arming train
// writes and the resolver at each chain's own boundary: dark at 1 and one short, live at it.
function armedTestnetSlots(row) {
    const slots = {};
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
        const v = row[coin + ':testnet'];
        assert.ok(Number.isInteger(v) && v > 1 && v < ProtocolChanges.UNARMED, coin + ':testnet is not a sized height: ' + v);
        slots[coin + ':testnet'] = v;
    }
    return slots;
}

function assertArmedOnEachTestnetChain(key) {
    const slots = armedTestnetSlots(ProtocolChanges.get(key));
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
        const v = slots[coin + ':testnet'];
        const at = (n) => ProtocolChanges.activeAt(key, 'testnet', coin, n, null);
        assert.strictEqual(at(1), false, coin + ':testnet at 1');
        assert.strictEqual(at(v - 1), false, coin + ':testnet one short of its activation');
        assert.strictEqual(at(v), true, coin + ':testnet at its activation');
    }
}

describe('protocol_changes CROSS_CHAIN_OFFER_LIST_EXPORT row @regression @tier1', function () {
    it('registers a frozen height map that is unarmed on mainnet and armed on each testnet chain', function () {
        assert.strictEqual(ProtocolChanges.registry.unitOf(KEY), 'height');
        const row = ProtocolChanges.get(KEY);
        assert.deepStrictEqual(row, {
            mainnet: ProtocolChanges.UNARMED,
            ...armedTestnetSlots(row),
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
        assert.strictEqual(Object.isFrozen(row), true);
    });

    it('stays inactive below the sentinel and is active from regtest genesis', function () {
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'mainnet', 'BTC', ProtocolChanges.UNARMED - 1, null), false);
        assertArmedOnEachTestnetChain(KEY);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', -1, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });

    it('is registry-only and keeps its part within the size limit', function () {
        assert.ok(REGISTRY_ONLY_STEMS.includes('cross_chain_offer_list_export_activation'));
        const text = fs.readFileSync(PART, 'utf8');
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        assert.ok(lines <= 400, 'gates_4.js is ' + lines + ' lines');
    });
});

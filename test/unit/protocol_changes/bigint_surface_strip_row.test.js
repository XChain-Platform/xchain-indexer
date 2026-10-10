/*********************************************************************
 * GENERATED
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ProtocolChanges = require('../../../src/protocol_changes.js');

const KEY = 'bigint_surface_strip_heights.BIGINT_SURFACE_STRIP_ACTIVATION';
const PART = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes', 'gates_3.js');

describe('protocol_changes BIGINT_SURFACE_STRIP_ACTIVATION row @regression @tier1', function () {
    it('registers a frozen per-chain height map that is unarmed on launched networks', function () {
        assert.strictEqual(ProtocolChanges.registry.unitOf(KEY), 'height');
        const row = ProtocolChanges.get(KEY);
        assert.deepStrictEqual(row, {
            'BTC:mainnet': ProtocolChanges.UNARMED,
            'LTC:mainnet': ProtocolChanges.UNARMED,
            'DOGE:mainnet': ProtocolChanges.UNARMED,
            'BTC:testnet': ProtocolChanges.UNARMED,
            'LTC:testnet': ProtocolChanges.UNARMED,
            'DOGE:testnet': ProtocolChanges.UNARMED,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
        assert.strictEqual(Object.isFrozen(row), true);
    });

    it('stays inactive below the sentinel and is active from regtest genesis', function () {
        assert.strictEqual(typeof ProtocolChanges.isBigIntSurfaceStripActive, 'function');
        for (const network of ['mainnet', 'testnet']) {
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                assert.strictEqual(
                    ProtocolChanges.isBigIntSurfaceStripActive(
                        network, coin, ProtocolChanges.UNARMED - 1),
                    false,
                    coin + ':' + network,
                );
                assert.strictEqual(
                    ProtocolChanges.isBigIntSurfaceStripActive(network, coin, ProtocolChanges.UNARMED),
                    false,
                    coin + ':' + network + ' must not arm at the indexer sentinel',
                );
            }
        }
        assert.strictEqual(ProtocolChanges.isBigIntSurfaceStripActive('regtest', 'BTC', -1), true);
        assert.strictEqual(ProtocolChanges.isBigIntSurfaceStripActive('regtest', 'BTC', 0), true);
        assert.strictEqual(ProtocolChanges.isBigIntSurfaceStripActive('unknown', 'BTC', 0), false);
        assert.strictEqual(ProtocolChanges.isBigIntSurfaceStripActive('mainnet', null, 0), false);
        assert.strictEqual(ProtocolChanges.isBigIntSurfaceStripActive('mainnet', 'BTC', NaN), false);
    });

    it('keeps the final registry part within the structure limit', function () {
        const text = fs.readFileSync(PART, 'utf8');
        assert.match(text, /Per-chain height at which the VM removes BigInt typed arrays/);
        assert.match(text, /Mirrors xchain-vm: its null launched-network slots are UNARMED here/);
        assert.strictEqual(text.split("addGate('" + KEY + "'").length - 1, 1);
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        assert.ok(lines <= 400, 'gates_3.js is ' + lines + ' lines');
    });
});

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
const PART = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes', 'gates_4.js');

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
        for (const network of ['mainnet', 'testnet']) {
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                assert.strictEqual(
                    ProtocolChanges.activeAt(KEY, network, coin, ProtocolChanges.UNARMED - 1, null),
                    false,
                    coin + ':' + network,
                );
            }
        }
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', -1, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });

    it('keeps the final registry part within the structure limit', function () {
        const text = fs.readFileSync(PART, 'utf8');
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        assert.ok(lines <= 400, 'gates_4.js is ' + lines + ' lines');
    });
});

/*********************************************************************
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
 **********************************************************************
 * GAS_CEILING_EXHAUSTED_ACTIVATION registry row
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ProtocolChanges = require('../../../../src/protocol_changes.js');
const { REGISTRY_ONLY_STEMS } = require('../../../helpers/gate_modules.js');

const KEY = 'gas_ceiling_exhausted_heights.GAS_CEILING_EXHAUSTED_ACTIVATION';
const PART = path.join(__dirname, '..', '..', '..', '..', 'src', 'protocol_changes', 'gates_5.js');

describe('protocol_changes GAS_CEILING_EXHAUSTED_ACTIVATION row @regression @tier1', function () {
    it('registers a frozen per-chain height map, unarmed on mainnet, armed on testnet at its v0.24.0 heights, live on regtest', function () {
        assert.strictEqual(ProtocolChanges.registry.unitOf(KEY), 'height');
        const row = ProtocolChanges.get(KEY);
        assert.deepStrictEqual(row, {
            'BTC:mainnet': ProtocolChanges.UNARMED,
            'LTC:mainnet': ProtocolChanges.UNARMED,
            'DOGE:mainnet': ProtocolChanges.UNARMED,
            'BTC:testnet': 156908,
            'LTC:testnet': 4927400,
            'DOGE:testnet': 68005165,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
        assert.strictEqual(Object.isFrozen(row), true);
    });

    it('stays dark on mainnet, arms testnet from its v0.24.0 height, and is active from regtest genesis', function () {
        const TESTNET = { BTC: 156908, LTC: 4927400, DOGE: 68005165 };
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'mainnet', coin, ProtocolChanges.UNARMED - 1, null),
                false, coin + ':mainnet');
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, TESTNET[coin] - 1, null), false, coin + ':testnet below');
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, TESTNET[coin], null), true, coin + ':testnet at');
        }
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', -1, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });

    it('is a registry-only stem', function () {
        assert.ok(REGISTRY_ONLY_STEMS.includes('gas_ceiling_exhausted_heights'));
    });

    it('keeps its registry part within the structure limit', function () {
        const text = fs.readFileSync(PART, 'utf8');
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        assert.ok(lines <= 400, 'gates_5.js is ' + lines + ' lines');
    });
});

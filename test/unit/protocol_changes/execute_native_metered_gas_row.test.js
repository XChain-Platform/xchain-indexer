'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert');
const gateRegistry = require('../../../src/consensus/gate_registry.js');
const { UNARMED, UNPINNED, REGTEST_ARMING } = require('../../../src/protocol_changes/shared_rows.js');

const KEY = 'execute_native_metered_gas_activation.EXECUTE_NATIVE_METERED_GAS_ACTIVATION';
const ENV = 'XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION';

describe('protocol_changes/EXECUTE_NATIVE_METERED_GAS row @regression @tier1', function () {
    const before = process.env[ENV];
    after(function () {
        if(before === undefined) delete process.env[ENV];
        else process.env[ENV] = before;
    });

    it('is a height row unarmed on mainnet and every testnet', function () {
        delete process.env[ENV];
        assert.deepStrictEqual(gateRegistry.get(KEY), {
            mainnet: UNARMED,
            testnet: UNARMED,
            regtest: UNPINNED,
        });
        assert.strictEqual(gateRegistry.activeAt(KEY, 'mainnet', 'LTC', UNARMED - 1, null), false);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', 'LTC', UNARMED - 1, null), false);
    });

    it('arms regtest only from the named environment height', function () {
        assert.strictEqual(REGTEST_ARMING[KEY].env, ENV);
        delete process.env[ENV];
        assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', 'LTC', 999, null), false);
        process.env[ENV] = '12';
        assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', 'LTC', 11, null), false);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', 'LTC', 12, null), true);
    });
});

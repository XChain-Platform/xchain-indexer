'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert');
const ProtocolChanges = require('../../../src/protocol_changes.js');

const KEY = 'protocol_changes.changes.APPLY_LENGTH_METER';

describe('protocol_changes/APPLY_LENGTH_METER row @regression @tier1', function () {
    it('is unarmed on production networks and active from regtest genesis', function () {
        const row = ProtocolChanges.get(KEY);
        assert.strictEqual(row.mainnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.testnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.regtest_time, 0);
        assert.strictEqual(ProtocolChanges.APPLY_LENGTH_METER_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.APPLY_LENGTH_METER_TESTNET_TIME, ProtocolChanges.UNARMED);
    });

    it('is present in the class table and registry in the same shape', function () {
        const table = new ProtocolChanges({ config: {}, util: {} }).changes;
        assert.ok(Object.prototype.hasOwnProperty.call(table, 'APPLY_LENGTH_METER'));
        assert.deepStrictEqual(table.APPLY_LENGTH_METER, ProtocolChanges.get(KEY));
        assert.strictEqual(ProtocolChanges.get('protocol_changes.APPLY_LENGTH_METER_MAINNET_TIME'), ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.APPLY_LENGTH_METER_TESTNET_TIME'), ProtocolChanges.UNARMED);
    });
});

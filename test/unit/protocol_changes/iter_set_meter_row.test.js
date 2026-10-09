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
const precedingTable = require('../../../src/protocol_changes/changes_4.js');

const KEY = 'protocol_changes.changes.ITER_SET_METER';

describe('protocol_changes/ITER_SET_METER row @regression @tier1', function () {
    it('is present in the class table and registry in the same shape', function () {
        const changes = new ProtocolChanges({ config: {}, util: {} }).changes;
        assert.ok(Object.prototype.hasOwnProperty.call(changes, 'ITER_SET_METER'));
        assert.deepStrictEqual(changes.ITER_SET_METER, ProtocolChanges.get(KEY));
        assert.deepStrictEqual(precedingTable[precedingTable.length - 1], [
            'ITER_SET_METER', '0.2.0', ProtocolChanges.UNARMED,
            ProtocolChanges.UNARMED, 0, 0, 0, 0,
        ]);
    });

    it('is unarmed on production networks and active from regtest genesis', function () {
        assert.strictEqual(ProtocolChanges.ITER_SET_METER_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.ITER_SET_METER_TESTNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.ITER_SET_METER_MAINNET_TIME'), ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.ITER_SET_METER_TESTNET_TIME'), ProtocolChanges.UNARMED);
        const row = ProtocolChanges.get(KEY);
        assert.strictEqual(row.mainnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.testnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.regtest_time, 0);
    });
});

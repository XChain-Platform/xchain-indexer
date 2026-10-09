'use strict';

// GENERATED

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert');
const ProtocolChanges = require('../../../../src/protocol_changes.js');

const KEY = 'protocol_changes.changes.STAKE_DELEGATED_SIGNING_KEY';

describe('protocol_changes/STAKE_DELEGATED_SIGNING_KEY row @regression @tier1', function () {
    it('is unarmed on production networks and active from regtest genesis', function () {
        const row = ProtocolChanges.get(KEY);
        assert.strictEqual(row.mainnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.testnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.regtest_time, 0);
        assert.strictEqual(ProtocolChanges.STAKE_DELEGATED_SIGNING_KEY_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.STAKE_DELEGATED_SIGNING_KEY_TESTNET_TIME, ProtocolChanges.UNARMED);
    });

    it('is present in the class table and registry in the same shape', function () {
        const table = new ProtocolChanges({ config: {}, util: {} }).changes;
        assert.ok(Object.prototype.hasOwnProperty.call(table, 'STAKE_DELEGATED_SIGNING_KEY'));
        assert.deepStrictEqual(table.STAKE_DELEGATED_SIGNING_KEY, ProtocolChanges.get(KEY));
        assert.strictEqual(ProtocolChanges.get('protocol_changes.STAKE_DELEGATED_SIGNING_KEY_MAINNET_TIME'), ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.STAKE_DELEGATED_SIGNING_KEY_TESTNET_TIME'), ProtocolChanges.UNARMED);
    });
});

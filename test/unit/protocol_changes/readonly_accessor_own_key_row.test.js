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
const ProtocolChanges = require('../../../src/protocol_changes.js');

const KEY = 'protocol_changes.changes.READONLY_ACCESSOR_OWN_KEY';

function build() {
    return new ProtocolChanges({ config: {}, util: {} }).changes.READONLY_ACCESSOR_OWN_KEY;
}

describe('protocol_changes/READONLY_ACCESSOR_OWN_KEY row @regression @tier1', function () {
    it('is a row in part 5, mainnet inert and testnet and regtest active from genesis', function () {
        const rows = require('../../../src/protocol_changes/changes_5.js');
        assert.ok(rows.some((r) => r[0] === 'READONLY_ACCESSOR_OWN_KEY'));
        assert.strictEqual(ProtocolChanges.READONLY_ACCESSOR_OWN_KEY_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.READONLY_ACCESSOR_OWN_KEY_TESTNET_TIME, 0);
        assert.deepStrictEqual(build(), {
            version_major: 0, version_minor: 2, version_revision: 0,
            mainnet_time: ProtocolChanges.UNARMED,
            testnet_time: 0,
            regtest_time: 0,
            mainnet_block: 0, testnet_block: 0, regtest_block: 0,
        });
    });

    it('registers the row and both network constants', function () {
        assert.deepStrictEqual(ProtocolChanges.get(KEY), build());
        assert.strictEqual(ProtocolChanges.get('protocol_changes.READONLY_ACCESSOR_OWN_KEY_MAINNET_TIME'),
            ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.READONLY_ACCESSOR_OWN_KEY_TESTNET_TIME'), 0);
    });

    it('mirrors the VM activation table the manifest reads', function () {
        const { ACCESSOR_OWN_KEY_ACTIVATION: gate } = require('xchain-vm/src/readonly-accessors.js');
        const row = build();
        assert.strictEqual(gate.mainnet === null ? ProtocolChanges.UNARMED : gate.mainnet, row.mainnet_time);
        assert.strictEqual(gate.testnet, row.testnet_time);
        assert.strictEqual(gate.regtest, row.regtest_time);
    });
});

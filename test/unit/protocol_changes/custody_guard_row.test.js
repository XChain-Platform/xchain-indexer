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

const ENV = 'CONTROLLER_CUSTODY_GUARD_REGTEST_TIME';
const KEY = 'protocol_changes.changes.CONTROLLER_CUSTODY_GUARD';

function build() {
    return new ProtocolChanges({ config: {}, util: {} }).changes.CONTROLLER_CUSTODY_GUARD;
}

describe('protocol_changes/CONTROLLER_CUSTODY_GUARD row @regression @tier1', function () {
    const saved = process.env[ENV];

    beforeEach(function () {
        delete process.env[ENV];
    });

    afterEach(function () {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    });

    it('is the first row in part 5 with both public networks unarmed', function () {
        const rows = require('../../../src/protocol_changes/changes_5.js');
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0][0], 'CONTROLLER_CUSTODY_GUARD');
        assert.strictEqual(ProtocolChanges.CONTROLLER_CUSTODY_GUARD_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.CONTROLLER_CUSTODY_GUARD_TESTNET_TIME, ProtocolChanges.UNARMED);
        assert.deepStrictEqual(build(), {
            version_major: 0, version_minor: 2, version_revision: 0,
            mainnet_time: ProtocolChanges.UNARMED,
            testnet_time: ProtocolChanges.UNARMED,
            regtest_time: 0,
            mainnet_block: 0, testnet_block: 0, regtest_block: 0,
        });
    });

    it('registers the row and both network constants', function () {
        assert.deepStrictEqual(ProtocolChanges.get(KEY), build());
        assert.strictEqual(ProtocolChanges.get('protocol_changes.CONTROLLER_CUSTODY_GUARD_MAINNET_TIME'),
            ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.CONTROLLER_CUSTODY_GUARD_TESTNET_TIME'),
            ProtocolChanges.UNARMED);
    });

    it('reads the regtest-only drill override when a fresh table is built', function () {
        process.env[ENV] = '9999999999';
        assert.strictEqual(build().regtest_time, 9999999999);
        process.env[ENV] = 'not-a-time';
        assert.strictEqual(build().regtest_time, 0);
    });
});

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

const ENV = 'EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME';

function build() {
    return new ProtocolChanges({ config: {}, util: {} }).changes.EXACT_INTEGER_WIRE_FIELDS;
}

describe('protocol_changes/EXACT_INTEGER_WIRE_FIELDS regtest switch @regression @tier1', function () {
    const saved = process.env[ENV];

    beforeEach(function () {
        delete process.env[ENV];
    });

    afterEach(function () {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    });

    it('ships unarmed on regtest when the variable is unset', function () {
        const row = build();
        assert.strictEqual(row.regtest_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.mainnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.testnet_time, 1791804379);
    });

    it('arms regtest from the variable and leaves the other networks alone', function () {
        process.env[ENV] = '1234567890';
        const row = build();
        assert.strictEqual(row.regtest_time, 1234567890);
        assert.strictEqual(row.mainnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.testnet_time, 1791804379);
    });

    it('fails closed to unarmed on a non-numeric value', function () {
        process.env[ENV] = 'not-a-time';
        assert.strictEqual(build().regtest_time, ProtocolChanges.UNARMED);
    });
});

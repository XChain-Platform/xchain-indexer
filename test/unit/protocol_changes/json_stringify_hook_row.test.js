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

// Compare the indexer's JSON_STRINGIFY_HOOK row with the literal xchain-vm froze for
// the same gate (JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME in src/index.js), read as text so
// no isolated-vm build is needed and a stale vendored copy cannot mask the comparison.

const assert = require('assert');
const fs     = require('fs');

const ProtocolChanges = require('../../../src/protocol_changes.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const VM_INDEX = siblingCheckout(__dirname, '../../../../xchain-vm/src/index.js');
const HOOK_RE  = /const\s+JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME\s*=\s*(\d+)\s*;/;

describe('protocol_changes/json_stringify_hook_row: the JSON_STRINGIFY_HOOK row matches the sibling VM gate', function () {
    it('mainnet, testnet and regtest all equal the literal frozen in xchain-vm/src/index.js', function () {
        if (!VM_INDEX.usable)
            return skipOrFail(this, VM_INDEX, 'the JSON_STRINGIFY_HOOK VM source parity guard');
        const text = fs.readFileSync(VM_INDEX.path, 'utf8');
        const m = text.match(HOOK_RE);
        assert.ok(m, 'xchain-vm/src/index.js does not declare JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME as a const literal');
        const vmValue = Number(m[1]);

        const row = ProtocolChanges.get('protocol_changes.changes.JSON_STRINGIFY_HOOK');
        assert.ok(row, 'protocol_changes.changes.JSON_STRINGIFY_HOOK row is missing');
        assert.strictEqual(row.mainnet_time, vmValue, 'mainnet_time');
        assert.strictEqual(row.testnet_time, vmValue, 'testnet_time');
        assert.strictEqual(row.regtest_time, vmValue, 'regtest_time');
    });
});

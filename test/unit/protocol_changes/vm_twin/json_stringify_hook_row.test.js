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

// Compare the indexer's JSON_STRINGIFY_HOOK row with the network map xchain-vm froze
// for the same gate.

const assert = require('assert');

const ProtocolChanges = require('../../../../src/protocol_changes.js');
const { JSON_STRINGIFY_HOOK_ACTIVATION } = require('xchain-vm');

describe('protocol_changes/json_stringify_hook_row: the JSON_STRINGIFY_HOOK row matches the sibling VM gate', function () {
    it('mainnet, testnet and regtest equal the matching xchain-vm activation slots', function () {
        const row = ProtocolChanges.get('protocol_changes.changes.JSON_STRINGIFY_HOOK');
        assert.ok(row, 'protocol_changes.changes.JSON_STRINGIFY_HOOK row is missing');
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            assert.strictEqual(row[network + '_time'], JSON_STRINGIFY_HOOK_ACTIVATION[network], network + '_time');
        }
    });
});

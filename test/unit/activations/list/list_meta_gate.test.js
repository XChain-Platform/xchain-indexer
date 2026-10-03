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
const ProtocolChanges = require('../../../../src/protocol_changes.js');
const constants = require('../../../../src/protocol/constants.js');

const KEY = 'list_meta_activation.LIST_META_ACTIVATION';

describe('list meta activation registry row', function () {
    it('is a height gate inert on mainnet and armed on testnet at the v0.21.3 heights', function () {
        assert.strictEqual(ProtocolChanges.registry.unitOf(KEY), 'height');
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'mainnet', 'BTC', 9999999998, null), false);
        for (const [coin, height] of [['BTC', 154971], ['LTC', 4905844], ['DOGE', 67961578]]) {
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, height - 1, null), false,
                coin + ':testnet');
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, height, null), true,
                coin + ':testnet');
        }
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });

    it('exports the list meta byte limits through protocol constants', function () {
        assert.strictEqual(constants.LIST_META_NAME_MAX_BYTES, 64);
        assert.strictEqual(constants.LIST_META_DESCRIPTION_MAX_BYTES, 512);
    });
});

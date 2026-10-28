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

const KEY = 'same_token_offer_refusal_activation.SAME_TOKEN_OFFER_REFUSAL_ACTIVATION';

describe('same-token offer refusal gate row @regression @tier1', function () {
    it('is unarmed on mainnet and testnet, has no per-chain testnet keys, and starts at regtest genesis', function () {
        const row = ProtocolChanges.get(KEY);
        assert.deepStrictEqual(row, {
            mainnet: ProtocolChanges.UNARMED,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
        assert.strictEqual(ProtocolChanges.registry.activeAt(KEY, 'mainnet', 'BTC', 9999999998, null), false);
        assert.strictEqual(ProtocolChanges.registry.activeAt(KEY, 'testnet', 'BTC', 9999999998, null), false);
        assert.strictEqual(ProtocolChanges.registry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });
});

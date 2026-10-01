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

const KEY = 'list_tick_coin_activation.LIST_TICK_COIN_ACTIVATION';

describe('list tick coin activation registry row', function () {
    it('is an inert height row outside regtest', function () {
        assert.strictEqual(ProtocolChanges.registry.unitOf(KEY), 'height');
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'mainnet', 'BTC', 9999999998, null), false);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, 9999999998, null), false);
        }
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });
});

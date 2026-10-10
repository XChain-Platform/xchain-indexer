/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const { REGTEST_ARMING } = require('../../../src/protocol_changes/shared_rows.js');

const KEY = 'cross_chain_remote_token_activation.CROSS_CHAIN_REMOTE_TOKEN_ACTIVATION';
const EXPECTED = {
    mainnet: ProtocolChanges.UNARMED,
    'BTC:testnet': ProtocolChanges.UNARMED,
    'LTC:testnet': ProtocolChanges.UNARMED,
    'DOGE:testnet': ProtocolChanges.UNARMED,
    testnet: ProtocolChanges.UNARMED,
    regtest: 0,
};

describe('CROSS_CHAIN_REMOTE_TOKEN_ACTIVATION', function () {
    it('is a frozen height row with explicit defaults for every launched key', function () {
        assert.strictEqual(ProtocolChanges.registry.unitOf(KEY), 'height');
        assert.deepStrictEqual(ProtocolChanges.get(KEY), EXPECTED);
        assert.strictEqual(Object.isFrozen(ProtocolChanges.get(KEY)), true);
    });

    it('stays unarmed on mainnet and every testnet chain', function () {
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'mainnet', 'BTC', ProtocolChanges.UNARMED - 1, null), false);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, ProtocolChanges.UNARMED - 1, null), false, coin);
        }
    });

    it('is active from regtest genesis without an environment arming lever', function () {
        assert.strictEqual(REGTEST_ARMING[KEY], undefined);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', -1, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });
});

/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const assert = require('assert');
const { toIndexerConfig } = require('../../../../src/coins/to_indexer_config.js');
const { resolveEscrowAddress } = require('../../../../src/consensus/bridge_checkpoint_check/escrow_address.js');
const { ESCROW_ROLE_PREFIX } = require('../../../../src/consensus/bridge_checkpoint_check/reasons.js');

describe('bridge_checkpoint_check/escrow_address', function () {
    it('resolves the BTC escrow address for DOGE on regtest', function () {
        const expected = toIndexerConfig('BTC', 'regtest').ADDRESS[ESCROW_ROLE_PREFIX + 'DOGE'];
        const actual = resolveEscrowAddress('BTC', 'DOGE', 'regtest');

        assert.strictEqual(typeof actual, 'string');
        assert.ok(actual.length > 0);
        assert.strictEqual(actual, expected);
    });

    it('returns null for malformed or missing chain and network inputs', function () {
        const invalidArguments = [
            ['btc', 'DOGE', 'regtest'],
            ['', 'DOGE', 'regtest'],
            ['BTC', '', 'regtest'],
            ['BTC', 'DOGE', ''],
            ['B', 'DOGE', 'regtest'],
            ['ABCDEFGHIJK', 'DOGE', 'regtest'],
        ];

        for (const args of invalidArguments)
            assert.strictEqual(resolveEscrowAddress(...args), null, args.join('/'));
    });

    it('returns null without throwing for an unknown chain', function () {
        let actual;

        assert.doesNotThrow(() => { actual = resolveEscrowAddress('NOPE', 'DOGE', 'regtest'); });
        assert.strictEqual(actual, null);
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict';

const assert = require('assert');
const { assertFeeDestination } = require('../../../src/config/fee_destination.js');

const INVALID_CONFIGS = [
    ['ADDRESS is missing', {}],
    ['FEE_DESTINATION is missing', { ADDRESS: {} }],
    ['FEE_DESTINATION is empty', { ADDRESS: { FEE_DESTINATION: '' } }],
    ['FEE_DESTINATION is null', { ADDRESS: { FEE_DESTINATION: null } }],
    ['FEE_DESTINATION is the placeholder', {
        ADDRESS: { FEE_DESTINATION: 'X'.repeat(34) },
    }],
];

describe('assertFeeDestination', function () {
    it('allows BTC for every destination shape', function () {
        const configs = [
            undefined, null, 'unexpected',
            { ADDRESS: { FEE_DESTINATION: 'real-address' } },
            ...INVALID_CONFIGS.map(([, config]) => config),
        ];
        for(const config of configs){
            assert.doesNotThrow(() => assertFeeDestination(config, 'BTC', 'mainnet'));
        }
    });

    for(const coin of ['LTC', 'DOGE']){
        for(const [condition, config] of INVALID_CONFIGS){
            it(`rejects ${coin} when ${condition}`, function () {
                assert.throws(
                    () => assertFeeDestination(config, coin, 'mainnet'),
                    (error) => error instanceof Error &&
                        error.message.includes('FEE_DESTINATION') && error.message.includes(coin)
                );
            });
        }

        it(`allows ${coin} with a real destination`, function () {
            const config = { ADDRESS: { FEE_DESTINATION: 'real-address' } };
            assert.doesNotThrow(() => assertFeeDestination(config, coin, 'mainnet'));
        });
    }
});

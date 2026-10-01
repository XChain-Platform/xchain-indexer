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
const constants = require('../../../src/protocol/constants.js');

const PRODUCER_KEY = 'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION';
const KEYS = [
    PRODUCER_KEY,
    'list_share_consumer_activation.LIST_SHARE_CONSUMER_ACTIVATION',
    'list_share_activation.LIST_SHARE_ACTIVATION',
    'list_union_activation.LIST_UNION_ACTIVATION',
    'list_transfer_activation.LIST_TRANSFER_ACTIVATION',
    'list_address_ref_activation.LIST_ADDRESS_REF_ACTIVATION',
];

describe('list sharing activation registry rows', function () {
    it('registers every list-sharing gate as an inert height row outside regtest', function () {
        for (const key of KEYS) {
            assert.strictEqual(ProtocolChanges.registry.unitOf(key), 'height', key);
            assert.strictEqual(ProtocolChanges.activeAt(key, 'mainnet', 'BTC', 9999999998, null), false, key);
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                const armedAt = key === PRODUCER_KEY ? 154750 : { BTC: 154750, LTC: 4904879, DOGE: 67956200 }[coin];
                assert.strictEqual(ProtocolChanges.activeAt(key, 'testnet', coin, armedAt - 1, null), false,
                    key + ' ' + coin + ':testnet below its cut height');
                assert.strictEqual(ProtocolChanges.activeAt(key, 'testnet', coin, armedAt, null), true,
                    key + ' ' + coin + ':testnet at its cut height');
            }
            assert.strictEqual(ProtocolChanges.activeAt(key, 'regtest', 'BTC', 0, null), true, key);
        }
    });

    it('keeps the producer row on the network plane', function () {
        const producer = ProtocolChanges.get(PRODUCER_KEY);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(producer, coin + ':testnet'), false);
        }
    });

    it('exports the list member limits through protocol constants', function () {
        assert.strictEqual(constants.LIST_SHARE_MAX_MEMBERS, 10000);
        assert.strictEqual(constants.LIST_UNION_MAX_MEMBERS, 16);
    });
});

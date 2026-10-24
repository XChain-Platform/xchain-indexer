/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('node:assert');
const coins = require('../../src/coins');
const { validateRegistry } = require('../check-chain-registry-donations');

function projectedRegistry() {
    const descriptors = [];
    for (const tick of coins.ALLOWED_COINS) {
        for (const network of coins.NETWORKS) {
            const coin = coins.getCoinConfig(tick, network);
            const adsDonationAddresses = {
                DONATE1: coin.addresses.DONATE1,
                DONATE2: coin.addresses.DONATE2,
                EXPLORER: coin.addresses.EXPLORER,
            };
            descriptors.push({
                id: `${coins.COIN_FULL_NAME[tick]}-${network}`,
                adsDonationAddresses,
                adsDonationAddress: adsDonationAddresses.DONATE1,
            });
        }
    }
    return { descriptors };
}

describe('bin/check-chain-registry-donations', function () {
    it('accepts the complete canonical role projection', function () {
        const registry = projectedRegistry();
        const count = validateRegistry(registry);
        assert.strictEqual(count, 9);
    });

    it('rejects an entirely legacy placeholder registry', function () {
        const registry = projectedRegistry();
        for (const descriptor of registry.descriptors) {
            delete descriptor.adsDonationAddresses;
            descriptor.adsDonationAddress = 'PLACEHOLDER_REPLACE_BEFORE_MAINNET';
        }
        assert.throws(() => validateRegistry(registry), /bitcoin-mainnet is missing donation roles/);
    });

    it('rejects a role that differs from the canonical coin registry', function () {
        const registry = projectedRegistry();
        registry.descriptors[0].adsDonationAddresses.DONATE2 = 'wrong';
        assert.throws(() => validateRegistry(registry), /bitcoin-mainnet donation roles differ/);
    });

    it('rejects a default that is not the projected DONATE1 address', function () {
        const registry = projectedRegistry();
        registry.descriptors[0].adsDonationAddress = registry.descriptors[0].adsDonationAddresses.DONATE2;
        assert.throws(() => validateRegistry(registry), /bitcoin-mainnet default donation address is not DONATE1/);
    });
});

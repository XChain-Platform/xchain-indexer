#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 *********************************************************************/

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const coins = require('../src/coins');

const root = path.resolve(__dirname, '..');

function validateRegistry(registry, coinRegistry = coins) {
    const entries = registry.descriptors;
    const expectedCount = coinRegistry.ALLOWED_COINS.length * coinRegistry.NETWORKS.length;
    if (!Array.isArray(entries) || entries.length !== expectedCount) {
        const count = Array.isArray(entries) ? entries.length : 0;
        throw new Error(`chain-registry descriptor count ${count} does not match ${expectedCount} coin/network pairs`);
    }

    const descriptors = new Map(entries.map((entry) => [entry.id, entry]));
    if (descriptors.size !== entries.length) {
        throw new Error('chain-registry contains duplicate descriptor ids');
    }

    for (const tick of coinRegistry.ALLOWED_COINS) {
        for (const network of coinRegistry.NETWORKS) {
            const coin = coinRegistry.getCoinConfig(tick, network);
            const id = `${coinRegistry.COIN_FULL_NAME[tick]}-${network}`;
            const descriptor = descriptors.get(id);
            if (!descriptor) throw new Error(`chain-registry descriptor missing: ${id}`);

            if (!descriptor.adsDonationAddresses) {
                throw new Error(`${id} is missing donation roles`);
            }

            const expected = {
                DONATE1: coin.addresses.DONATE1,
                DONATE2: coin.addresses.DONATE2,
                EXPLORER: coin.addresses.EXPLORER,
            };
            if (!isDeepStrictEqual(descriptor.adsDonationAddresses, expected)) {
                throw new Error(`${id} donation roles differ from the canonical coin registry`);
            }
            if (descriptor.adsDonationAddress !== expected.DONATE1) {
                throw new Error(`${id} default donation address is not DONATE1`);
            }
        }
    }

    return expectedCount;
}

function main() {
    const hubRoot = process.env.XCHAIN_HUB_DIR || path.resolve(root, '..', 'xchain-hub');
    const registryPath = path.join(hubRoot, 'src', 'chain-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const expectedCount = validateRegistry(registry);
    console.log(`chain-registry donation projection OK (role-based, ${expectedCount} descriptors)`);
}

if (require.main === module) main();

module.exports = { validateRegistry };

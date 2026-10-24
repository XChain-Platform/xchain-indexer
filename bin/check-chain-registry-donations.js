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
const coins = require('../src/coins');

const root = path.resolve(__dirname, '..');
const hubRoot = process.env.XCHAIN_HUB_DIR || path.resolve(root, '..', 'xchain-hub');
const registryPath = path.join(hubRoot, 'src', 'chain-registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const descriptors = new Map((registry.descriptors || []).map((entry) => [entry.id, entry]));
const expectedCount = coins.ALLOWED_COINS.length * coins.NETWORKS.length;
const legacy = [];
const current = [];

if (descriptors.size !== expectedCount) {
    throw new Error(`chain-registry descriptor count ${descriptors.size} does not match ${expectedCount} coin/network pairs`);
}

for (const tick of coins.ALLOWED_COINS) {
    for (const network of coins.NETWORKS) {
        const coin = coins.getCoinConfig(tick, network);
        const id = `${coins.COIN_FULL_NAME[tick]}-${network}`;
        const descriptor = descriptors.get(id);
        if (!descriptor) throw new Error(`chain-registry descriptor missing: ${id}`);

        if (!descriptor.adsDonationAddresses) {
            if (descriptor.adsDonationAddress !== 'PLACEHOLDER_REPLACE_BEFORE_MAINNET') {
                throw new Error(`${id} has neither donation roles nor the legacy placeholder`);
            }
            legacy.push(id);
            continue;
        }

        const expected = {
            DONATE1: coin.addresses.DONATE1,
            DONATE2: coin.addresses.DONATE2,
            EXPLORER: coin.addresses.EXPLORER,
        };
        if (JSON.stringify(descriptor.adsDonationAddresses) !== JSON.stringify(expected)) {
            throw new Error(`${id} donation roles differ from the canonical coin registry`);
        }
        if (descriptor.adsDonationAddress !== expected.DONATE1) {
            throw new Error(`${id} default donation address is not DONATE1`);
        }
        current.push(id);
    }
}

if (legacy.length && current.length) {
    throw new Error(`chain-registry mixes ${legacy.length} legacy and ${current.length} role-based donation descriptors`);
}

console.log(`chain-registry donation projection OK (${current.length ? 'role-based' : 'legacy'}, ${expectedCount} descriptors)`);

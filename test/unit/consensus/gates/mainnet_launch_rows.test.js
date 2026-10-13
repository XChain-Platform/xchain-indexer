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
const path = require('path');

const ENTRY = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'protocol_changes.js');
const { UNARMED } = require(ENTRY);
const { admitsPrelaunch } = require('../../../../src/consensus/gates/prelaunch_seed_sources.js');

describe('mainnet launch registry rows', function () {
    const reg = require(ENTRY);
    const keyed = (stem) => reg.rows().filter(([k]) => k.includes(stem));

    it('registers the launch instant on mainnet only', function () {
        const rows = keyed('mainnet_launch_activation.MAINNET_LAUNCH_ACTIVATION');
        assert.strictEqual(rows.length, 1);
        const value = rows[0][1];
        assert.strictEqual(value.mainnet, 1798761600);
        assert.strictEqual(value.testnet, UNARMED);
        assert.strictEqual(value.regtest, 0);
    });

    it('registers an empty prelaunch seed source map', function () {
        const rows = keyed('prelaunch_seed_sources.PRELAUNCH_SEED_SOURCES');
        assert.strictEqual(rows.length, 1);
        assert.deepStrictEqual(rows[0][1], {});
    });

    it('admits nothing extra from the empty map before launch', function () {
        const seedSources = keyed('prelaunch_seed_sources.PRELAUNCH_SEED_SOURCES')[0][1];
        const input = { network: 'mainnet', coin: 'BTC', blockTime: 1, data: 'SEND|0|x', source: '1Seed' };
        assert.strictEqual(admitsPrelaunch(input, { launchActive: false, seedSources }), false);
    });
});

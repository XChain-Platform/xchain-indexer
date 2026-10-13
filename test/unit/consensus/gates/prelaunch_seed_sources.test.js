/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
const {
    isPrelaunchSeedSource: admits,
} = require('../../../../src/consensus/gates/prelaunch_seed_sources.js');

const SEEDS = {
    'BTC:mainnet': ['1Seed'],
    'LTC:mainnet': ['Lseed'],
    'DOGE:mainnet': [],
};

describe('prelaunch seed sources', function(){
    it('admits only a pinned seed source', function(){
        assert.strictEqual(admits('1Seed', 'BTC', SEEDS), true);
        assert.strictEqual(admits('Lseed', 'LTC', SEEDS), true);
        assert.strictEqual(admits('1Seed', 'DOGE', SEEDS), false);
        assert.strictEqual(admits('Lseed', 'BTC', SEEDS), false);
        assert.strictEqual(admits('1seed', 'BTC', SEEDS), false);
        assert.strictEqual(admits(' 1Seed', 'BTC', SEEDS), false);
        assert.strictEqual(admits('1Seed ', 'BTC', SEEDS), false);
        assert.strictEqual(admits('1Seed', 'XYZ', SEEDS), false);
    });

    it('fails closed on a malformed source or coin', function(){
        assert.strictEqual(admits('', 'BTC', { 'BTC:mainnet': [''] }), false);
        assert.strictEqual(admits(null, 'BTC', SEEDS), false);
        assert.strictEqual(admits(undefined, 'BTC', SEEDS), false);
        assert.strictEqual(admits(7, 'BTC', SEEDS), false);
        assert.strictEqual(admits('1Seed', '', SEEDS), false);
        assert.strictEqual(admits('1Seed', null, SEEDS), false);
        assert.strictEqual(admits('1Seed', 5, SEEDS), false);
    });

    it('fails closed on a malformed seed map', function(){
        assert.strictEqual(admits('1Seed', 'BTC', null), false);
        assert.strictEqual(admits('1Seed', 'BTC', undefined), false);
        assert.strictEqual(admits('1Seed', 'BTC', '1Seed'), false);
        assert.strictEqual(admits('1Seed', 'BTC', {}), false);
        assert.strictEqual(admits('1Seed', 'BTC', { 'BTC:mainnet': '1Seed' }), false);
        assert.strictEqual(admits('1Seed', 'BTC', { 'BTC:mainnet': null }), false);
        assert.strictEqual(
            admits('1Seed', 'BTC', Object.create({ 'BTC:mainnet': ['1Seed'] })),
            false
        );
    });
});

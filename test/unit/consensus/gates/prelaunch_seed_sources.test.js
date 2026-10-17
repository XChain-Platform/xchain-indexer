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
    admitsPrelaunch,
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

    it('admits a prelaunch transaction by network, launch, validator format or seed source', function(){
        const bar = String.fromCharCode(124);
        const wire = (...p) => p.join(bar);
        const make = (network, data, source) =>
            ({ network, coin: 'BTC', blockTime: 1700000000, data, source });
        const user = wire('SEND', '0', 'x');
        const off = { launchActive: false, seedSources: SEEDS };
        assert.strictEqual(admitsPrelaunch(make('testnet', user, 'z'), off), true);
        assert.strictEqual(admitsPrelaunch(make('regtest', user, 'z'), off), true);
        assert.strictEqual(
            admitsPrelaunch(make('mainnet', user, 'z'), { launchActive: true, seedSources: SEEDS }),
            true
        );
        assert.strictEqual(admitsPrelaunch(make('mainnet', wire('PRICE', '0', 'x'), 'z'), off), true);
        assert.strictEqual(admitsPrelaunch(make('mainnet', user, '1Seed'), off), true);
        assert.strictEqual(admitsPrelaunch(make('mainnet', wire('PRICE', '1', 'x'), 'z'), off), false);
        assert.strictEqual(admitsPrelaunch(make('mainnet', user, 'z'), off), false);
    });

    it('refuses a truthy non-true launch flag and a bad network', function(){
        const make = (network) =>
            ({ network, coin: 'BTC', blockTime: 1, data: 'SEND', source: 'z' });
        const flag = (launchActive) => ({ launchActive, seedSources: SEEDS });
        assert.strictEqual(admitsPrelaunch(make('mainnet'), flag(1)), false);
        assert.strictEqual(admitsPrelaunch(make('mainnet'), flag('true')), false);
        assert.strictEqual(admitsPrelaunch(make('MAINNET'), flag(false)), false);
        assert.strictEqual(admitsPrelaunch(make('TESTNET'), flag(false)), false);
        assert.strictEqual(admitsPrelaunch(make(undefined), flag(false)), false);
        assert.strictEqual(admitsPrelaunch(make(''), flag(false)), false);
        assert.strictEqual(admitsPrelaunch(make('signet'), flag(false)), false);
    });

    it('fails closed on a null seed map, missing options or a non-object input', function(){
        const input = { network: 'mainnet', coin: 'BTC', blockTime: 1, data: 'SEND', source: '1Seed' };
        assert.strictEqual(admitsPrelaunch(input, { launchActive: false, seedSources: null }), false);
        assert.strictEqual(admitsPrelaunch(input), false);
        assert.throws(() => admitsPrelaunch(null, { launchActive: true }), TypeError);
        assert.throws(() => admitsPrelaunch('x', {}), TypeError);
        assert.throws(() => admitsPrelaunch(undefined), TypeError);
    });
});

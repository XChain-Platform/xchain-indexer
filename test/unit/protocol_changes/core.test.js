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

// The registry API on a FRESH registry per test: addGate validation, the miss
// throw, and activeAt against every unit. The thresholds below are written as
// literals so a change in the predicate shows up as a literal mismatch.

const assert = require('assert');
const core   = require('../../../src/protocol_changes/core.js');

const { UNARMED, UNPINNED, UNITS, RegistryMissError, createRegistry } = core;

const HEIGHT_TABLE = {
    'BTC:testnet': 145000, 'DOGE:testnet': 67000000, mainnet: UNARMED, testnet: 10, regtest: 0, 'LTC:mainnet': UNPINNED,
};

describe('protocol_changes/core: addGate validation @regression @tier1', function () {
    it('accepts every unit and stores a frozen copy of the table', function () {
        const r = createRegistry();
        r.addGate('a.H', 'height', { mainnet: 1 });
        r.addGate('a.T', 'time', { mainnet: 1786060800 });
        r.addGate('a.E', 'epoch', { mainnet: 0, regtest: UNPINNED });
        r.addGate('a.R', 'ruleset', { '1.0.0': { mainnet: 0, testnet: 0, regtest: 0 } });
        r.addGate('a.C', 'constant', ['x', 1, { k: /re/i }]);
        assert.deepStrictEqual(r.keys(), ['a.H', 'a.T', 'a.E', 'a.R', 'a.C']);
        assert.ok(Object.isFrozen(r.get('a.H')));
        assert.ok(Object.isFrozen(r.get('a.R')['1.0.0']));
        assert.strictEqual(r.unitOf('a.R'), 'ruleset');
        assert.deepStrictEqual(UNITS, ['height', 'time', 'epoch', 'ruleset', 'constant']);
    });

    it('refuses a key outside the grammar, a duplicate key and an unknown unit', function () {
        const r = createRegistry();
        assert.throws(() => r.addGate('nodot', 'height', { mainnet: 0 }), /key grammar/);
        assert.throws(() => r.addGate('bad key.X', 'height', { mainnet: 0 }), /key grammar/);
        assert.throws(() => r.addGate(42, 'height', { mainnet: 0 }), /key grammar/);
        r.addGate('stem.X', 'height', { mainnet: 0 });
        assert.throws(() => r.addGate('stem.X', 'time', { mainnet: 0 }), /duplicate key stem\.X/);
        assert.throws(() => r.addGate('stem.Y', 'blocks', { mainnet: 0 }), /unit must be one of/);
    });

    it('refuses a threshold table that is not plain numbers or UNPINNED, and a constant the canonicaliser refuses', function () {
        const r = createRegistry();
        assert.throws(() => r.addGate('stem.A', 'height', [1, 2]), /plain object/);
        assert.throws(() => r.addGate('stem.B', 'height', { mainnet: '0' }), /finite number or UNPINNED/);
        assert.throws(() => r.addGate('stem.C', 'time', { mainnet: NaN }), /finite number or UNPINNED/);
        assert.throws(() => r.addGate('stem.D', 'ruleset', { '1.0.0': 5 }), /versions to network tables/);
        assert.throws(() => r.addGate('stem.E', 'constant', { f: () => 1 }), /refused function/);
        assert.throws(() => r.addGate('stem.F', 'constant', new Map()), /refused Map/);
        assert.deepStrictEqual(r.keys(), []);
    });

    it('UNARMED is the year-2286 number and UNPINNED is null, and both survive as table values', function () {
        assert.strictEqual(UNARMED, 9999999999);
        assert.strictEqual(UNPINNED, null);
        const r = createRegistry();
        r.addGate('stem.G', 'height', { mainnet: UNARMED, testnet: UNPINNED });
        assert.deepStrictEqual(r.get('stem.G'), { mainnet: 9999999999, testnet: null });
    });
});

describe('protocol_changes/core: copy() @regression @tier1', function () {
    it('hands back an equal, mutable, fresh deep copy that never reaches the stored row', function () {
        const r = createRegistry();
        r.addGate('a.H', 'height', { 'BTC:testnet': 145000, regtest: 0 });
        r.addGate('a.C', 'constant', ['x', { k: /re/i }]);
        r.addGate('a.N', 'constant', 42);
        const h = r.copy('a.H');
        assert.deepStrictEqual(h, r.get('a.H'));
        assert.notStrictEqual(h, r.get('a.H'));
        assert.ok(!Object.isFrozen(h));
        h['BTC:testnet'] = 1;
        assert.strictEqual(r.get('a.H')['BTC:testnet'], 145000, 'the stored row must not move');
        assert.notStrictEqual(r.copy('a.H'), h, 'every call is a fresh copy');
        const c = r.copy('a.C');
        assert.ok(!Object.isFrozen(c) && !Object.isFrozen(c[1]));
        assert.strictEqual(c[1].k, r.get('a.C')[1].k, 'a RegExp is handed back as it is');
        assert.strictEqual(r.copy('a.N'), 42);
        assert.throws(() => r.copy('a.X'), (e) => e instanceof RegistryMissError);
    });
});

describe('protocol_changes/core: get, has, rows and the miss throw @regression @tier1', function () {
    it('get() throws RegistryMissError naming the key; has() answers false', function () {
        const r = createRegistry();
        r.addGate('stem.X', 'height', { mainnet: 0 });
        assert.strictEqual(r.has('stem.X'), true);
        assert.strictEqual(r.has('stem.Y'), false);
        assert.throws(() => r.get('stem.Y'), (e) => e instanceof RegistryMissError && e.key === 'stem.Y' && /stem\.Y/.test(e.message));
        assert.throws(() => r.unitOf('stem.Y'), RegistryMissError);
        assert.throws(() => r.activeAt('stem.Y', 'mainnet', 'BTC', 1, 1), RegistryMissError);
    });

    it('rows() lists [key, value] in insertion order, time-table rows included', function () {
        const r = createRegistry();
        r.addGate('stem.X', 'height', { mainnet: 0 });
        r.addChange('SEND', '0.1.0', 0, 0, 0, 0, 0, 0);
        r.addGate('stem.Y', 'constant', 7);
        assert.deepStrictEqual(r.rows(), [
            ['stem.X', { mainnet: 0 }],
            ['protocol_changes.changes.SEND', {
                version_major: 0, version_minor: 1, version_revision: 0,
                mainnet_time: 0, testnet_time: 0, regtest_time: 0, mainnet_block: 0, testnet_block: 0, regtest_block: 0,
            }],
            ['stem.Y', 7],
        ]);
        assert.strictEqual(r.unitOf('protocol_changes.changes.SEND'), core.CHANGE_UNIT);
    });

    it('addChange() refuses a duplicate name, a bad version and a non-numeric threshold', function () {
        const r = createRegistry();
        r.addChange('SEND', '0.1.0', 0, 0, 0, 0, 0, 0);
        assert.throws(() => r.addChange('SEND', '0.1.0', 0, 0, 0, 0, 0, 0), /duplicate protocol change SEND/);
        assert.throws(() => r.addChange('X', '1.0', 0, 0, 0, 0, 0, 0), /version must be X\.Y\.Z/);
        assert.throws(() => r.addChange('X', '0.1.0', 'abc', 0, 0, 0, 0, 0), /mainnet_time must be a finite number/);
        assert.throws(() => r.addChange('X', '0.1.0', 0, 0, 0, 0, 0, undefined), /regtest_block must be a finite number/);
        assert.throws(() => r.addChange(7, '0.1.0', 0, 0, 0, 0, 0, 0), /name must be a string/);
    });
});

describe('protocol_changes/core: activeAt resolves the coin key before the network key @regression @tier1', function () {
    const r = createRegistry();
    before(function () { r.addGate('stem.H', 'height', HEIGHT_TABLE); });

    it('a coin key wins over the network key on the same network', function () {
        // testnet is 10; BTC:testnet is 145000. Height 100 is active only without the coin.
        assert.strictEqual(r.activeAt('stem.H', 'testnet', 'BTC', 100, 0), false);
        assert.strictEqual(r.activeAt('stem.H', 'testnet', null, 100, 0), true);
        assert.strictEqual(r.activeAt('stem.H', 'testnet', 'BTC', 145000, 0), true);
        assert.strictEqual(r.activeAt('stem.H', 'testnet', 'BTC', 144999, 0), false);
    });

    it('a coin with no coin key falls back to the network key', function () {
        assert.strictEqual(r.activeAt('stem.H', 'testnet', 'LTC', 10, 0), true);
        assert.strictEqual(r.activeAt('stem.H', 'testnet', 'LTC', 9, 0), false);
    });

    it('UNARMED, UNPINNED, an unknown network and an unparseable height are never active', function () {
        assert.strictEqual(r.activeAt('stem.H', 'mainnet', 'BTC', 9999999998, 0), false);
        assert.strictEqual(r.activeAt('stem.H', 'mainnet', 'BTC', 9999999999, 0), true, 'UNARMED is a number: active at 2286');
        assert.strictEqual(r.activeAt('stem.H', 'mainnet', 'LTC', 0, 0), false, 'UNPINNED coin key: 0 >= null must not arm it');
        assert.strictEqual(r.activeAt('stem.H', 'mainnet', 'LTC', 9999999999, 0), false, 'UNPINNED never falls back to the network key');
        assert.strictEqual(r.activeAt('stem.H', 'signet', 'BTC', 1, 0), false);
        assert.strictEqual(r.activeAt('stem.H', 'constructor', null, 1, 0), false, 'an inherited member is not a threshold');
        assert.strictEqual(r.activeAt('stem.H', undefined, null, 1, 0), false);
        assert.strictEqual(r.activeAt('stem.H', 'regtest', null, 'abc', 0), false);
        assert.strictEqual(r.activeAt('stem.H', 'regtest', null, null, 0), false);
        assert.strictEqual(r.activeAt('stem.H', 'regtest', null, '0', 0), true, 'a decimal string height parses');
    });
});

describe('protocol_changes/core: activeAt by unit @regression @tier1', function () {
    const r = createRegistry();
    before(function () {
        r.addGate('stem.T', 'time', { mainnet: 1786060800, testnet: 0, regtest: 0 });
        r.addGate('stem.E', 'epoch', { mainnet: 0, testnet: 151200, regtest: UNPINNED });
        r.addGate('stem.R', 'ruleset', { '1.0.0': { mainnet: 0, testnet: 0, regtest: 0 } });
        r.addGate('stem.C', 'constant', 36);
        r.addChange('SEND', '0.1.0', 0, 0, 0, 0, 0, 0);
    });

    it('time compares the time argument and ignores the height', function () {
        assert.strictEqual(r.activeAt('stem.T', 'mainnet', 'BTC', 999999999, 1786060799), false);
        assert.strictEqual(r.activeAt('stem.T', 'mainnet', 'BTC', 0, 1786060800), true);
        assert.strictEqual(r.activeAt('stem.T', 'regtest', 'DOGE', 0, 0), true);
        assert.strictEqual(r.activeAt('stem.T', 'mainnet', 'BTC', 0, 'x'), false);
    });

    it('epoch compares the height argument the way isRollcallActive does, a null gate inert', function () {
        assert.strictEqual(r.activeAt('stem.E', 'testnet', 'BTC', 151199, 0), false);
        assert.strictEqual(r.activeAt('stem.E', 'testnet', 'BTC', 151200, 0), true);
        assert.strictEqual(r.activeAt('stem.E', 'mainnet', 'BTC', 0, 0), true);
        assert.strictEqual(r.activeAt('stem.E', 'regtest', 'BTC', 0, 0), false);
    });

    it('ruleset, constant and time-table rows have no generic predicate and say so', function () {
        assert.throws(() => r.activeAt('stem.R', 'mainnet', 'BTC', 1, 1), /unsupported unit ruleset for stem\.R/);
        assert.throws(() => r.activeAt('stem.C', 'mainnet', 'BTC', 1, 1), /unsupported unit constant for stem\.C/);
        assert.throws(() => r.activeAt('protocol_changes.changes.SEND', 'mainnet', 'BTC', 1, 1), /unsupported unit change/);
    });
});

describe('protocol_changes/core: applyChanges @regression @tier1', function () {
    it('feeds every part in order and resolves a function-valued argument at build time', function () {
        const seen = [];
        const target = { addChange: (...args) => seen.push(args) };
        let n = 5;
        core.applyChanges(target, [[['A', '0.1.0', 0, 0, 0, 0, 0, 0]], [['B', '0.2.0', 1, 0, () => n, 0, 0, 0]]]);
        assert.deepStrictEqual(seen, [['A', '0.1.0', 0, 0, 0, 0, 0, 0], ['B', '0.2.0', 1, 0, 5, 0, 0, 0]]);
        n = 6;
        core.applyChanges(target, [[['B', '0.2.0', 1, 0, () => n, 0, 0, 0]]]);
        assert.deepStrictEqual(seen[2], ['B', '0.2.0', 1, 0, 6, 0, 0, 0], 'resolved per build, not per load');
    });
});

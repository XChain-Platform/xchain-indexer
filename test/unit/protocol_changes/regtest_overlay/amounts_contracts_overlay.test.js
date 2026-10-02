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
const { isDeepStrictEqual } = require('util');

const registry = require('../../../../src/protocol_changes.js');

const AMOUNTS_ENV = 'XC_AMOUNTS_PRICE_REGTEST_ACTIVATION';
const TIME_ENV = 'XC_AMOUNTS_PRICE_REGTEST_TIME';
const CONTRACTS_ENV = 'XC_CONTRACTS_REGTEST_ACTIVATION';
const AMOUNTS_KEYS = [
    'dispenser_send_amount_compare_activation.DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION',
    'price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION',
];
const TIME_KEYS = [
    'amount_representability_activation.AMOUNT_REPRESENTABILITY_ACTIVATION',
];
const CONTRACTS_KEYS = [
    'vote_callback_binding_activation.VOTE_CALLBACK_BINDING_REQUIRES_USABLE_METHOD',
];
const TARGET_KEYS = AMOUNTS_KEYS.concat(TIME_KEYS, CONTRACTS_KEYS);
const COMMITTED_REGTEST = new Map([
    [AMOUNTS_KEYS[0], 0],
    [AMOUNTS_KEYS[1], null],
    [TIME_KEYS[0], 0],
    [CONTRACTS_KEYS[0], 0],
]);

function withArmEnv(amounts, time, contracts, fn) {
    const values = { [AMOUNTS_ENV]: amounts, [TIME_ENV]: time, [CONTRACTS_ENV]: contracts };
    const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    try {
        for (const [name, value] of Object.entries(values)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        return fn();
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

function rowMap() {
    return new Map(registry.rows());
}

function changedKeys(amounts, time, contracts) {
    const bare = withArmEnv(undefined, undefined, undefined, rowMap);
    const armed = withArmEnv(amounts, time, contracts, rowMap);
    return [...armed]
        .filter(([key, value]) => !isDeepStrictEqual(value, bare.get(key)))
        .map(([key]) => key)
        .sort();
}

describe('protocol_changes: amounts, price, and contracts regtest overlay @regression @tier1', function () {
    it('leaves the four committed regtest values unchanged when all variables are unset', function () {
        withArmEnv(undefined, undefined, undefined, () => {
            for (const [key, value] of COMMITTED_REGTEST) {
                assert.strictEqual(registry.get(key).regtest, value, key);
                assert.strictEqual(registry.registry.entries.get(key).value.regtest, value, key + ' committed value');
            }
        });
    });

    it('moves exactly the two amounts and price height rows', function () {
        assert.deepStrictEqual(changedKeys('41', undefined, undefined), AMOUNTS_KEYS.slice().sort());
        withArmEnv('41', undefined, undefined, () => {
            for (const key of AMOUNTS_KEYS) assert.strictEqual(registry.get(key).regtest, 41, key);
        });
    });

    it('moves exactly the amount representability Unix instant row', function () {
        assert.deepStrictEqual(changedKeys(undefined, '1790812800', undefined), TIME_KEYS);
        withArmEnv(undefined, '1790812800', undefined, () => {
            assert.strictEqual(registry.get(TIME_KEYS[0]).regtest, 1790812800);
        });
    });

    it('moves exactly the contracts height row', function () {
        assert.deepStrictEqual(changedKeys(undefined, undefined, '43'), CONTRACTS_KEYS);
        withArmEnv(undefined, undefined, '43', () => {
            assert.strictEqual(registry.get(CONTRACTS_KEYS[0]).regtest, 43);
        });
    });

    it('leaves committed values in place when every variable is refused', function () {
        withArmEnv('abc', 'abc', 'abc', () => {
            for (const [key, value] of COMMITTED_REGTEST) {
                assert.strictEqual(registry.get(key).regtest, value, key);
            }
        });
    });

    it('never changes mainnet or testnet entries', function () {
        const bare = withArmEnv(undefined, undefined, undefined, rowMap);
        const armed = withArmEnv('41', '1790812800', '43', rowMap);

        for (const key of TARGET_KEYS) {
            const before = bare.get(key);
            const after = armed.get(key);
            for (const network of Object.keys(before).filter((name) => name.includes('mainnet') || name.includes('testnet'))) {
                assert.strictEqual(after[network], before[network], key + ' ' + network);
            }
        }
    });
});

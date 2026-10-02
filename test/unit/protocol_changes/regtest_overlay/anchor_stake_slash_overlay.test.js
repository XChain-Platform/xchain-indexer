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

const STAKE_ENV = 'XC_ANCHOR_STAKE_REGTEST_ACTIVATION';
const SLASH_ENV = 'XC_ANCHOR_SLASH_REGTEST_ACTIVATION';
const STAKE_KEYS = [
    'anchor_bundle_order_activation.ANCHOR_BUNDLE_ORDER_ACTIVATION',
    'archive_match_count_activation.ARCHIVE_MATCH_COUNT_ACTIVATION',
    'stake_weight_collation_activation.STAKE_WEIGHT_COLLATION_ACTIVATION',
];
const SLASH_KEYS = [
    'slash_grid_activation.SLASH_GRID_ACTIVATION',
    'slash_ledger_consolidation_activation.SLASH_LEDGER_CONSOLIDATION_ACTIVATION',
];
const TARGET_KEYS = STAKE_KEYS.concat(SLASH_KEYS);

function withArmEnv(stake, slash, fn) {
    const saved = { [STAKE_ENV]: process.env[STAKE_ENV], [SLASH_ENV]: process.env[SLASH_ENV] };
    try {
        if (stake === undefined) delete process.env[STAKE_ENV];
        else process.env[STAKE_ENV] = stake;
        if (slash === undefined) delete process.env[SLASH_ENV];
        else process.env[SLASH_ENV] = slash;
        return fn();
    } finally {
        for (const name of [STAKE_ENV, SLASH_ENV]) {
            if (saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
    }
}

function rowMap() {
    return new Map(registry.rows());
}

describe('protocol_changes: anchor stake and slash regtest overlay @regression @tier1', function () {
    it('leaves all five committed regtest values at zero when the variables are unset', function () {
        withArmEnv(undefined, undefined, () => {
            for (const key of TARGET_KEYS) {
                assert.strictEqual(registry.get(key).regtest, 0, key);
                assert.strictEqual(registry.registry.entries.get(key).value.regtest, 0, key + ' committed value');
            }
        });
    });

    it('moves exactly the five intended rows when both variables are set', function () {
        const bare = withArmEnv(undefined, undefined, rowMap);
        const armed = withArmEnv('41', '43', rowMap);
        const changed = [...armed].filter(([key, value]) => !isDeepStrictEqual(value, bare.get(key))).map(([key]) => key);

        assert.deepStrictEqual(changed.sort(), TARGET_KEYS.slice().sort());
        for (const key of STAKE_KEYS) assert.strictEqual(armed.get(key).regtest, 41, key);
        for (const key of SLASH_KEYS) assert.strictEqual(armed.get(key).regtest, 43, key);
    });

    it('never changes the mainnet or testnet entries', function () {
        const bare = withArmEnv(undefined, undefined, rowMap);
        const armed = withArmEnv('41', '43', rowMap);

        for (const key of TARGET_KEYS) {
            const before = bare.get(key);
            const after = armed.get(key);
            for (const network of Object.keys(before).filter((name) => name.includes('mainnet') || name.includes('testnet'))) {
                assert.strictEqual(after[network], before[network], key + ' ' + network);
            }
        }
    });
});

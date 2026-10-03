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

const HEIGHT_ENV = 'XC_LISTS_MARKET_REGTEST_ACTIVATION';
const TIME_ENV = 'XC_LISTS_MARKET_REGTEST_TIME';
const HEIGHT_KEYS = [
    'list_owner_activation.LIST_OWNER_ACTIVATION',
    'empty_allow_list_denies_activation.EMPTY_ALLOW_LIST_DENIES',
    'swap_edit_rematch_activation.SWAP_EDIT_REMATCH_ACTIVATION',
    'token_gate_list_at_block.TOKEN_GATE_LIST_AT_BLOCK',
    'list_reference_validity_activation.LIST_REFERENCE_REQUIRES_VALID_LIST',
    'list_head_follows_edit_chain.LIST_HEAD_FOLLOWS_EDIT_CHAIN',
    'order_swap_maker_policy_admission.ORDER_SWAP_MAKER_POLICY_ADMISSION',
    'order_swap_payout_policy_activation.ORDER_SWAP_PAYOUT_POLICY_PER_TOKEN',
    'issue_policy_list_detach.ISSUE_POLICY_LIST_DETACH',
    'bridge_policy_detach_activation.BRIDGE_POLICY_DETACH',
    'callback_compensation_activation.CALLBACK_COMPENSATES_EVERY_DEBITED_HOLDER',
];
const TIME_KEYS = [
    'dispenser_settlement_price_activation.DISPENSER_SETTLEMENT_PRICE_ACTIVATION',
    'dispenser_freshness_proven_use_activation.DISPENSER_FRESHNESS_PROVEN_USE_ACTIVATION',
    'list_edit_remove_activation.LIST_EDIT_REMOVE_ACTIVATION',
];
const TARGET_KEYS = HEIGHT_KEYS.concat(TIME_KEYS);

function withArmEnv(height, time, fn) {
    const values = { [HEIGHT_ENV]: height, [TIME_ENV]: time };
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

function changedKeys(height, time) {
    const bare = withArmEnv(undefined, undefined, rowMap);
    const armed = withArmEnv(height, time, rowMap);
    return [...armed]
        .filter(([key, value]) => !isDeepStrictEqual(value, bare.get(key)))
        .map(([key]) => key)
        .sort();
}

describe('protocol_changes: lists and market regtest overlay @regression @tier1', function () {
    it('leaves all fourteen committed regtest values at zero when both variables are unset', function () {
        withArmEnv(undefined, undefined, () => {
            for (const key of TARGET_KEYS) {
                assert.strictEqual(registry.get(key).regtest, 0, key);
                assert.strictEqual(registry.registry.entries.get(key).value.regtest, 0, key + ' committed value');
            }
        });
    });

    it('moves exactly the eleven height rows', function () {
        assert.deepStrictEqual(changedKeys('41', undefined), HEIGHT_KEYS.slice().sort());
        withArmEnv('41', undefined, () => {
            for (const key of HEIGHT_KEYS) assert.strictEqual(registry.get(key).regtest, 41, key);
        });
    });

    it('moves exactly the three Unix instant rows', function () {
        assert.deepStrictEqual(changedKeys(undefined, '1790812800'), TIME_KEYS.slice().sort());
        withArmEnv(undefined, '1790812800', () => {
            for (const key of TIME_KEYS) assert.strictEqual(registry.get(key).regtest, 1790812800, key);
        });
    });

    it('leaves committed values in place when both variables are refused', function () {
        withArmEnv('abc', 'abc', () => {
            for (const key of TARGET_KEYS) assert.strictEqual(registry.get(key).regtest, 0, key);
        });
    });

    it('never changes mainnet or testnet entries', function () {
        const bare = withArmEnv(undefined, undefined, rowMap);
        const armed = withArmEnv('41', '1790812800', rowMap);

        for (const key of TARGET_KEYS) {
            const before = bare.get(key);
            const after = armed.get(key);
            for (const network of Object.keys(before).filter((name) => name.includes('mainnet') || name.includes('testnet'))) {
                assert.strictEqual(after[network], before[network], key + ' ' + network);
            }
        }
    });
});

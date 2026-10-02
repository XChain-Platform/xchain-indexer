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
const ProtocolChanges = require('../../../../src/protocol_changes.js');
const {
    LIST_META_GATE_KEY,
    isListMetaActive,
    isListMetaApplyActive,
} = require('../../../../src/consensus/gates/list_meta_gate.js');

describe('list share metadata gate readers', function () {
    it('exports the registry key without exporting the activation value', function () {
        const gate = require('../../../../src/consensus/gates/list_meta_gate.js');
        assert.strictEqual(LIST_META_GATE_KEY, 'list_meta_activation.LIST_META_ACTIVATION');
        assert.strictEqual(Object.prototype.hasOwnProperty.call(gate, 'LIST_META_ACTIVATION'), false);
    });

    it('is active for the hub and every apply chain at regtest genesis', function () {
        assert.strictEqual(isListMetaActive(0, 'regtest'), true);
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            assert.strictEqual(isListMetaApplyActive(coin, 'regtest', 0), true, coin);
    });

    it('stays inactive on mainnet and every testnet chain below the sentinel', function () {
        const height = 9999999998;
        assert.strictEqual(isListMetaActive(height, 'mainnet'), false);
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            assert.strictEqual(isListMetaApplyActive(coin, 'mainnet', height), false,
                coin + ':mainnet');
            assert.strictEqual(isListMetaActive(height, 'testnet'), false,
                coin + ':testnet hub');
            assert.strictEqual(isListMetaApplyActive(coin, 'testnet', height), false,
                coin + ':testnet apply');
        }
    });

    it('returns false for a non-string network', function () {
        for(const network of [null, undefined, 0, false, {}]){
            assert.strictEqual(isListMetaActive(0, network), false);
            assert.strictEqual(isListMetaApplyActive('BTC', network, 0), false);
        }
    });

    it('passes the exact hub and apply axes to the registry', function () {
        const registry = require('../../../../src/consensus/gate_registry.js');
        const gatePath = require.resolve('../../../../src/consensus/gates/list_meta_gate.js');
        const originalActiveAt = registry.activeAt;
        const calls = [];
        let results;

        registry.activeAt = (...args) => {
            calls.push(args);
            return calls.length;
        };
        delete require.cache[gatePath];
        try{
            const freshGate = require(gatePath);
            results = [
                freshGate.isListMetaActive(41, 'testnet'),
                freshGate.isListMetaApplyActive('LTC', 'mainnet', 42),
            ];
        } finally {
            registry.activeAt = originalActiveAt;
            delete require.cache[gatePath];
        }

        assert.deepStrictEqual(results, [1, 2]);
        assert.deepStrictEqual(calls, [
            [LIST_META_GATE_KEY, 'testnet', 'BTC', 41, null],
            [LIST_META_GATE_KEY, 'mainnet', 'LTC', 42, null],
        ]);
    });

    it('matches the registry over networks, caller chains, and heights', function () {
        const networks = ['mainnet', 'testnet', 'regtest', 'unknown'];
        const coins = ['BTC', 'LTC', 'DOGE'];
        const heights = [-1, 0, 1, 154777, 4905004, 67956922, 9999999998, 9999999999];

        for(const network of networks){
            for(const coin of coins){
                for(const height of heights){
                    assert.strictEqual(
                        isListMetaActive(height, network),
                        ProtocolChanges.activeAt(LIST_META_GATE_KEY, network, 'BTC', height, null),
                        coin + ':' + network + ' hub at ' + height
                    );
                    assert.strictEqual(
                        isListMetaApplyActive(coin, network, height),
                        ProtocolChanges.activeAt(LIST_META_GATE_KEY, network, coin, height, null),
                        coin + ':' + network + ' apply at ' + height
                    );
                }
            }
        }
    });
});

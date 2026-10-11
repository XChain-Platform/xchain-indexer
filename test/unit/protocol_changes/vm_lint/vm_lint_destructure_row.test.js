'use strict';

const assert = require('assert');
const registry = require('../../../../src/consensus/gate_registry.js');

const KEY = 'vm_lint_destructure_heights.VM_LINT_DESTRUCTURE_ACTIVATION';
const UNARMED = 9999999999;

describe('protocol_changes VM lint destructure row', function () {
    it('registers the per-chain height map', function () {
        assert.strictEqual(registry.registry.unitOf(KEY), 'height');
        assert.deepStrictEqual(registry.get(KEY), {
            'BTC:mainnet': UNARMED,
            'LTC:mainnet': UNARMED,
            'DOGE:mainnet': UNARMED,
            'BTC:testnet': UNARMED,
            'LTC:testnet': UNARMED,
            'DOGE:testnet': UNARMED,
            testnet: UNARMED,
            regtest: 0,
        });
    });

    it('is active on regtest at genesis and unarmed on every public chain', function () {
        assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        for (const network of ['mainnet', 'testnet']) {
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                assert.strictEqual(registry.activeAt(KEY, network, coin, 10000000, null), false,
                    coin + ':' + network);
            }
        }
    });
});

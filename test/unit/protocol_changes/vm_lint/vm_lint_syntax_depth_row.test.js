'use strict';

const assert = require('assert');
const registry = require('../../../../src/consensus/gate_registry.js');

const KEY = 'vm_lint_syntax_depth_heights.VM_LINT_SYNTAX_DEPTH_ACTIVATION';
const UNARMED = 9999999999;

describe('protocol_changes VM lint syntax-depth row', function () {
    it('registers the per-chain height map, unarmed on every public chain', function () {
        assert.strictEqual(registry.registry.unitOf(KEY), 'height');
        assert.deepStrictEqual(registry.get(KEY), {
            'BTC:mainnet': UNARMED,
            'LTC:mainnet': UNARMED,
            'DOGE:mainnet': UNARMED,
            'BTC:testnet': 156908,
            'LTC:testnet': 4927400,
            'DOGE:testnet': 68005165,
            testnet: UNARMED,
            regtest: 0,
        });
    });

    it('is active on regtest at genesis, dark on mainnet, and armed on testnet from its v0.24.0 height', function () {
        const TESTNET = { BTC: 156908, LTC: 4927400, DOGE: 68005165 };
        assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(registry.activeAt(KEY, 'mainnet', coin, UNARMED - 1, null), false, coin + ':mainnet');
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, TESTNET[coin] - 1, null), false, coin + ':testnet below');
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, TESTNET[coin], null), true, coin + ':testnet at');
        }
    });
});

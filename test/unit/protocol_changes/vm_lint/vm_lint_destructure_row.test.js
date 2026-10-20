'use strict';

const assert = require('assert');
const registry = require('../../../../src/consensus/gate_registry.js');

const KEY = 'vm_lint_destructure_heights.VM_LINT_DESTRUCTURE_ACTIVATION';
const UNARMED = 9999999999;

// The v0.23.0 cut armed this row with one sized height per testnet chain. The values are read
// from the registry row, never repeated here, so the case grades the shape the arming train
// writes and the resolver at each chain's own boundary: dark at 1 and one short, live at it.
function armedTestnetSlots(row) {
    const slots = {};
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
        const v = row[coin + ':testnet'];
        assert.ok(Number.isInteger(v) && v > 1 && v < UNARMED, coin + ':testnet is not a sized height: ' + v);
        slots[coin + ':testnet'] = v;
    }
    return slots;
}

function assertArmedOnEachTestnetChain(key) {
    const slots = armedTestnetSlots(registry.get(key));
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
        const v = slots[coin + ':testnet'];
        const at = (n) => registry.activeAt(key, 'testnet', coin, n, null);
        assert.strictEqual(at(1), false, coin + ':testnet at 1');
        assert.strictEqual(at(v - 1), false, coin + ':testnet one short of its activation');
        assert.strictEqual(at(v), true, coin + ':testnet at its activation');
    }
}

describe('protocol_changes VM lint destructure row', function () {
    it('registers the per-chain height map', function () {
        assert.strictEqual(registry.registry.unitOf(KEY), 'height');
        assert.deepStrictEqual(registry.get(KEY), {
            'BTC:mainnet': UNARMED,
            'LTC:mainnet': UNARMED,
            'DOGE:mainnet': UNARMED,
            ...armedTestnetSlots(registry.get(KEY)),
            testnet: UNARMED,
            regtest: 0,
        });
    });

    it('is active on regtest at genesis, unarmed on every mainnet chain and armed on each testnet chain', function () {
        assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(registry.activeAt(KEY, 'mainnet', coin, UNARMED - 1, null), false, coin + ':mainnet');
        }
        assertArmedOnEachTestnetChain(KEY);
    });
});

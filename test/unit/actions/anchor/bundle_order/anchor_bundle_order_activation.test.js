'use strict';

const assert = require('assert');
const gateRegistry = require('../../../../../src/consensus/gate_registry');

const BUNDLE_ORDER_KEY = 'anchor_bundle_order_activation.ANCHOR_BUNDLE_ORDER_ACTIVATION';
const ANCHOR_KEY = 'anchor_activation.ANCHOR_ACTIVATION';

describe('ANCHOR bundle order activation', function () {
    it('is active from genesis on regtest and fails closed for invalid heights', function () {
        assert.strictEqual(gateRegistry.activeAt(BUNDLE_ORDER_KEY, 'regtest', null, 70000000, null), true);
        assert.strictEqual(gateRegistry.activeAt(BUNDLE_ORDER_KEY, 'regtest', null, 0, null), true);
        assert.strictEqual(gateRegistry.activeAt(BUNDLE_ORDER_KEY, 'regtest', null, NaN, null), false);
        assert.strictEqual(gateRegistry.activeAt(BUNDLE_ORDER_KEY, 'regtest', null, null, null), false);
        assert.strictEqual(gateRegistry.activeAt(BUNDLE_ORDER_KEY, 'regtest', null, undefined, null), false);
    });

    it('remains unarmed on public networks and rejects an unknown network', function () {
        assert.strictEqual(gateRegistry.activeAt(BUNDLE_ORDER_KEY, 'mainnet', null, 70000000, null), false);
        assert.strictEqual(gateRegistry.activeAt(BUNDLE_ORDER_KEY, 'testnet', null, 70000000, null), false);
        assert.strictEqual(gateRegistry.activeAt(BUNDLE_ORDER_KEY, 'bogus', null, 70000000, null), false);
    });

    it('has the ANCHOR gate active on every network at the bundle test height', function () {
        assert.strictEqual(gateRegistry.activeAt(ANCHOR_KEY, 'mainnet', null, 70000000, null), true);
        assert.strictEqual(gateRegistry.activeAt(ANCHOR_KEY, 'testnet', null, 70000000, null), true);
        assert.strictEqual(gateRegistry.activeAt(ANCHOR_KEY, 'regtest', null, 70000000, null), true);
    });
});

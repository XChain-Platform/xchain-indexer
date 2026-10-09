'use strict';

const assert = require('assert');
const path = require('path');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const { UNARMED } = require('../../../src/protocol_changes/shared_rows.js');

const VM_MODULE = 'src/index/lint_destructure_heights.js';
const COIN_KEYS = [
    'BTC:mainnet',
    'LTC:mainnet',
    'DOGE:mainnet',
    'BTC:testnet',
    'LTC:testnet',
    'DOGE:testnet',
];
const vmTarget = process.env.XCHAIN_VM_DIR
    ? path.join(process.env.XCHAIN_VM_DIR, VM_MODULE)
    : path.join('..', '..', '..', '..', 'xchain-vm', VM_MODULE);
const verdict = siblingCheckout(__dirname, vmTarget);

function indexerActivation() {
    return require('../../../src/consensus/gate_registry')
        .copy('vm_lint_destructure_heights.VM_LINT_DESTRUCTURE_ACTIVATION');
}

describe('consensus/vm_lint_destructure_matches_vm: VM activation map @regression @tier1', function () {
    it('matches every VM mainnet and testnet activation', function () {
        const indexer = indexerActivation();
        if (!verdict.usable)
            return skipOrFail(this, verdict, 'the destructure activation map');

        const vmActivation = require(verdict.path).LINT_DESTRUCTURE_ACTIVATION;
        for (const coinKey of COIN_KEYS) {
            const vmHeight = vmActivation[coinKey];
            if (vmHeight === null) {
                assert.strictEqual(indexer[coinKey], UNARMED,
                    coinKey + ' must pair VM null with indexer UNARMED');
                continue;
            }
            assert.ok(Number.isFinite(vmHeight), coinKey + ' VM activation must be null or a finite height');
            assert.strictEqual(indexer[coinKey], vmHeight, coinKey + ' activation drifted from the VM');
        }
    });

    it('keeps the indexer regtest activation at genesis', function () {
        assert.strictEqual(indexerActivation().regtest, 0);
    });
});

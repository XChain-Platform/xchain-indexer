/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const path = require('path');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const XChainVM = require('xchain-vm');
const { runVmExecution } = require('../../../src/actions/execute/run_vm.js');

const KEY = 'bigint_surface_strip_heights.BIGINT_SURFACE_STRIP_ACTIVATION';
const VM_MODULE = 'src/index/bigint_surface_strip_heights.js';
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
    : require.resolve('xchain-vm/' + VM_MODULE);
const {
    BIGINT_SURFACE_STRIP_ACTIVATION: vmActivation,
    isBigIntSurfaceStripActive: vmActivationAt,
} = require(vmTarget);

function indexerActivation() {
    return ProtocolChanges.copy(KEY);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1,
    VM_STATE_READ: 100,
    VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100,
    VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000,
    VM_XCALL_CALLBACK: 20000,
};

function executionContext(network, vm) {
    const indexerDb = {
        getContractState: async () => ({}),
        getOracleDataForVM: async () => ({}),
        getCrossChainDataForVM: async () => ({}),
        getPollResultsForVM: async () => ({}),
        getContractStakeDataForVM: async () => ({}),
        createSavepoint: async (name) => name,
        releaseSavepoint: async () => {},
    };
    return {
        config: { NETWORK: network, CHAIN: 'LTC', COIN: 'LTC' },
        actions: {
            vm,
            protocolChanges: { isEnabled: async () => false },
        },
        indexerDb,
        providerDeadlineWindows: null,
    };
}

function executionProbe(height, actionIndex) {
    return {
        error: null,
        gasCost: 0,
        contractInfo: {
            code: 'module.exports=function(){return typeof BigInt64Array;};',
        },
        data: {
            METHOD: 'default',
            SOURCE: 'bigint-surface-probe',
            CONTRACT_ACTION_INDEX: 17,
            ACTION_INDEX: actionIndex,
            TX_HASH: 'bigint-surface-probe-' + actionIndex,
            TX_VOUT: actionIndex,
            BLOCK_INDEX: height,
            BLOCK_TIME: 0,
        },
    };
}

describe('consensus/bigint_surface_strip_matches_vm: activation parity @regression @tier1', function () {
    it('matches every VM mainnet and testnet activation', function () {
        const indexer = indexerActivation();
        for (const coinKey of COIN_KEYS) {
            const vmHeight = vmActivation[coinKey];
            if (vmHeight === null) {
                assert.strictEqual(indexer[coinKey], ProtocolChanges.UNARMED,
                    coinKey + ' must pair VM null with indexer UNARMED');
                continue;
            }
            assert.ok(Number.isFinite(vmHeight), coinKey + ' VM activation must be null or a finite height');
            assert.strictEqual(indexer[coinKey], vmHeight, coinKey + ' activation drifted from the VM');
        }
        assert.strictEqual(ProtocolChanges.isBigIntSurfaceStripActive('testnet', 'DOGE', ProtocolChanges.UNARMED), false);
        assert.strictEqual(vmActivationAt('testnet', 'DOGE', ProtocolChanges.UNARMED), false);
        assert.strictEqual(vmActivationAt('regtest', 'LTC', -1), true);
        assert.strictEqual(ProtocolChanges.isBigIntSurfaceStripActive('regtest', 'LTC', -1), true);
        assert.strictEqual(vmActivationAt('regtest', 'LTC', 0), true);
        assert.strictEqual(ProtocolChanges.isBigIntSurfaceStripActive('regtest', 'LTC', 0), true);
    });

    it('passes the production network, coin and height inputs into vm.execute()', async function () {
        const forwarded = [];
        const vm = new XChainVM({
            execution: 'in-process',
            gasSchedule: GAS_SCHEDULE,
            gasCeiling: 1000000,
        });
        const executingVm = {
            execute: async (opts) => {
                forwarded.push(opts);
                return vm.execute(opts);
            },
        };
        const regtest = executionProbe(73, 1);
        const mainnet = executionProbe(74, 2);
        vm.beginBlock();
        try {
            await runVmExecution.call(executionContext('regtest', executingVm), regtest, { GAS_CEILING: 1000000 });
            await runVmExecution.call(executionContext('mainnet', executingVm), mainnet, { GAS_CEILING: 1000000 });
        } finally {
            vm.endBlock();
            await vm.shutdown();
        }

        assert.deepStrictEqual(forwarded.map((opts) => [
            opts.network,
            opts.contractAddress.split(':')[1],
            opts.blockContext.height,
        ]), [
            ['regtest', 'LTC', 73],
            ['mainnet', 'LTC', 74],
        ]);
        assert.strictEqual(regtest.vmError, null);
        assert.strictEqual(regtest.vmReturnValue, '"undefined"');
        assert.strictEqual(mainnet.vmError, null);
        assert.strictEqual(mainnet.vmReturnValue, '"function"');
        assert.strictEqual(
            ProtocolChanges.isBigIntSurfaceStripActive('regtest', 'LTC', 73),
            vmActivationAt('regtest', 'LTC', 73),
        );
        assert.strictEqual(
            ProtocolChanges.isBigIntSurfaceStripActive('mainnet', 'LTC', 74),
            vmActivationAt('mainnet', 'LTC', 74),
        );
    });

    it('keeps the indexer regtest activation at genesis', function () {
        assert.strictEqual(indexerActivation().regtest, 0);
    });
});

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
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { codeIdentity } = require('../../../bin/consensus-identity.js');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const XChainVM = require('xchain-vm');
const { runVmExecution } = require('../../../src/actions/execute/run_vm.js');

const KEY = 'bigint_surface_strip_heights.BIGINT_SURFACE_STRIP_ACTIVATION';
const IDENTITY_PIN = path.resolve(__dirname, '../../../bin/pins/at1-consensus-identity.json');
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
const LITERAL_VM_CALLS = [
    path.resolve(__dirname, '../../../src/actions/deploy/constructor_run.js'),
    path.resolve(__dirname, '../../../src/actions/execute/controller_guard.js'),
];
const {
    BIGINT_SURFACE_STRIP_ACTIVATION: vmActivation,
    isBigIntSurfaceStripActive: vmActivationAt,
} = require(vmTarget);

function indexerActivation() {
    return ProtocolChanges.copy(KEY);
}

function indexerActivationAt(network, coin, height) {
    return ProtocolChanges.activeAt(KEY, network, coin, height, null);
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

function objectProperty(node, name) {
    return node.properties.find((property) =>
        property.type === 'Property' && !property.computed && property.key.name === name);
}

function literalVmOptions(source, filename) {
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    const calls = [];
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
            !node.callee.computed && node.callee.property.name === 'execute' &&
            node.arguments[0] && node.arguments[0].type === 'ObjectExpression') {
            calls.push(node.arguments[0]);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    }
    visit(ast);
    assert.strictEqual(calls.length, 1, filename + ' must contain one literal vm.execute() call');
    return calls[0];
}

function assertLiteralVmFlagInputs(source, filename) {
    const options = literalVmOptions(source, filename);
    const contractAddress = objectProperty(options, 'contractAddress');
    const network = objectProperty(options, 'network');
    const blockContext = objectProperty(options, 'blockContext');
    assert.ok(contractAddress, filename + ' must pass a coin-bearing contractAddress');
    assert.ok(network, filename + ' must pass network');
    assert.ok(blockContext && blockContext.value.type === 'ObjectExpression',
        filename + ' must pass a literal blockContext');
    const height = objectProperty(blockContext.value, 'height');
    assert.ok(height, filename + ' must pass blockContext.height');
    return { contractAddress, network, height };
}

function renamedProperty(source, property) {
    return source.slice(0, property.key.start) + 'omittedInput' + source.slice(property.key.end);
}

describe('consensus/bigint_surface_strip_matches_vm: activation parity @regression @tier1', function () {
    it('matches every VM mainnet and testnet activation', function () {
        const indexer = indexerActivation();
        for (const coinKey of COIN_KEYS) {
            const vmHeight = vmActivation[coinKey];
            if (vmHeight === null) {
                assert.strictEqual(indexer[coinKey], ProtocolChanges.UNARMED,
                    coinKey + ' must pair VM null with indexer UNARMED');
                const [coin, network] = coinKey.split(':');
                assert.strictEqual(indexerActivationAt(network, coin, ProtocolChanges.UNARMED - 1), false);
                continue;
            }
            assert.ok(Number.isFinite(vmHeight), coinKey + ' VM activation must be null or a finite height');
            assert.strictEqual(indexer[coinKey], vmHeight, coinKey + ' activation drifted from the VM');
            const [coin, network] = coinKey.split(':');
            assert.strictEqual(indexerActivationAt(network, coin, vmHeight - 1),
                vmActivationAt(network, coin, vmHeight - 1));
            assert.strictEqual(indexerActivationAt(network, coin, vmHeight),
                vmActivationAt(network, coin, vmHeight));
        }
        assert.strictEqual(indexerActivationAt('testnet', 'DOGE', ProtocolChanges.UNARMED - 1), false);
        assert.strictEqual(vmActivationAt('testnet', 'DOGE', ProtocolChanges.UNARMED - 1), false);
        assert.strictEqual(indexerActivationAt('regtest', 'LTC', -1), false);
        assert.strictEqual(vmActivationAt('regtest', 'LTC', -1), true);
        assert.strictEqual(vmActivationAt('regtest', 'LTC', 0), true);
        assert.strictEqual(indexerActivationAt('regtest', 'LTC', 0), true);
        assert.strictEqual(indexerActivationAt('unknown', 'LTC', 0), false);
        assert.strictEqual(vmActivationAt('unknown', 'LTC', 0), false);

        const rowHash = codeIdentity('regtest').armed_map_rows[KEY];
        const pin = JSON.parse(fs.readFileSync(IDENTITY_PIN, 'utf8'));
        assert.strictEqual(pin.bare_checkout.armed_map_rows[KEY], rowHash);
        assert.strictEqual(pin.armed_regtest_venue.armed_map_rows[KEY], rowHash);
    });

    it('passes the production network, coin and height inputs into vm.execute()', async function () {
        for (const filename of LITERAL_VM_CALLS) {
            const source = fs.readFileSync(filename, 'utf8');
            const inputs = assertLiteralVmFlagInputs(source, filename);
            for (const property of Object.values(inputs)) {
                assert.throws(
                    () => assertLiteralVmFlagInputs(renamedProperty(source, property), filename),
                    /must pass/,
                    filename + ' input-removal mutant survived',
                );
            }
        }

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
            indexerActivationAt('regtest', 'LTC', 73),
            vmActivationAt('regtest', 'LTC', 73),
        );
        assert.strictEqual(
            indexerActivationAt('mainnet', 'LTC', 74),
            vmActivationAt('mainnet', 'LTC', 74),
        );
    });

    it('keeps the indexer regtest activation at genesis', function () {
        assert.strictEqual(indexerActivation().regtest, 0);
    });
});

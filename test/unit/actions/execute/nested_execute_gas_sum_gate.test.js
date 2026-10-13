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
const sinon = require('sinon');
const ProtocolChanges = require('../../../../src/protocol_changes.js');
const { KEY, boundedAt, bankUnusedGas } = require('../../../../src/actions/execute/nested_gas_sum.js');
const { stubGate } = require('../../../helpers/gate_modules.js');

describe('actions/execute/nested_gas_sum: the bounded nested refund sum @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('is a registry-only height row, armed only on regtest', function () {
        assert.strictEqual(ProtocolChanges.registry.unitOf(KEY), 'height');
        assert.strictEqual(boundedAt({ NETWORK: 'regtest', COIN: 'BTC' }, { BLOCK_INDEX: 0 }), true);
        assert.strictEqual(boundedAt({ NETWORK: 'mainnet', COIN: 'BTC' }, { BLOCK_INDEX: 900000 }), false);
    });

    it('sums unbounded before the gate', function () {
        assert.strictEqual(bankUnusedGas(10, { gasUnusedSubtree: 500 }, false, 100), 510);
        assert.strictEqual(bankUnusedGas(0, { gasUnusedSubtree: undefined }, false, 100), 0);
    });

    it('caps the sum at the caller metered gas after the gate', function () {
        assert.strictEqual(bankUnusedGas(60, { gasUnusedSubtree: 70 }, true, 100), 100);
        assert.strictEqual(bankUnusedGas(10, { gasUnusedSubtree: 20 }, true, 100), 30);
    });

    it('drops negative and non-finite addends after the gate', function () {
        assert.strictEqual(bankUnusedGas(10, { gasUnusedSubtree: -5 }, true, 100), 10);
        assert.strictEqual(bankUnusedGas(10, { gasUnusedSubtree: Infinity }, true, 100), 10);
        assert.strictEqual(bankUnusedGas(10, { gasUnusedSubtree: 5 }, true, undefined), 0);
    });

    it('boundedAt follows the registry answer', function () {
        stubGate(sinon, KEY, true);
        assert.strictEqual(boundedAt({ NETWORK: 'mainnet', COIN: 'BTC' }, { BLOCK_INDEX: 1 }), true);
        stubGate(sinon, KEY, false);
        assert.strictEqual(boundedAt({ NETWORK: 'regtest', COIN: 'BTC' }, { BLOCK_INDEX: 1 }), false);
    });

    describe('production call sites', function () {
        const { runVmExecution } = require('../../../../src/actions/execute/run_vm.js');
        const { applyConstructorEffects } = require('../../../../src/actions/deploy/constructor_effects.js');

        const EMITTED = [
            { action: 'EXECUTE', gasUnusedSubtree: 70, resultActionIndex: 11 },
            { action: 'EXECUTE', gasUnusedSubtree: 70, resultActionIndex: 12 },
        ];

        function vmHandler(network) {
            return {
                config: { NETWORK: network, CHAIN: 'BTC', COIN: 'BTC' },
                actions: {
                    vm: { execute: async () => ({ success: true, gasUsed: 100, returnValue: null, stateChanges: [], stateDeletes: [], emittedActions: EMITTED }) },
                    protocolChanges: { isEnabled: async () => false },
                },
                indexerDb: {
                    getContractState: async () => ({}),
                    getOracleDataForVM: async () => ({}),
                    getCrossChainDataForVM: async () => ({}),
                    getPollResultsForVM: async () => ({}),
                    getContractStakeDataForVM: async () => ({}),
                    createSavepoint: async (n) => n,
                    releaseSavepoint: async () => {},
                    rollbackToSavepoint: async () => {},
                    createContractEmission: async () => {},
                },
                providerDeadlineWindows: null,
                processEmission: async () => {},
                processSlashEmission: async () => {},
            };
        }

        function vmCtx(blockIndex) {
            return {
                error: null,
                gasCost: 0,
                contractInfo: { code: 'module.exports=function(){};' },
                data: { METHOD: 'default', SOURCE: 's', CONTRACT_ACTION_INDEX: 1, ACTION_INDEX: 1, TX_HASH: 'h', TX_VOUT: 0, BLOCK_INDEX: blockIndex, BLOCK_TIME: 1 },
            };
        }

        it('run_vm banks the capped refund on regtest and the plain sum on mainnet', async function () {
            const armed = vmCtx(0);
            await runVmExecution.call(vmHandler('regtest'), armed, { GAS_CEILING: 1000000 });
            assert.strictEqual(armed.nestedGasUnused, 100);
            const legacy = vmCtx(900000);
            await runVmExecution.call(vmHandler('mainnet'), legacy, { GAS_CEILING: 1000000 });
            assert.strictEqual(legacy.nestedGasUnused, 140);
        });

        function deployHandler(network) {
            return {
                config: { NETWORK: network, CHAIN: 'BTC', COIN: 'BTC' },
                actions: { actionExecute: { processEmission: async () => {} } },
                indexerDb: {
                    createSavepoint: async (n) => n,
                    releaseSavepoint: async () => {},
                    rollbackToSavepoint: async () => {},
                    createContractState: async () => {},
                    createContractEmission: async () => {},
                },
            };
        }

        function deployRun(blockIndex) {
            return {
                data: { ACTION_INDEX: 5, BLOCK_INDEX: blockIndex, BLOCK_TIME: 1 },
                totalGas: 100,
                constructorResult: { success: true, stateChanges: [], stateDeletes: [], emittedActions: EMITTED },
            };
        }

        it('constructor_effects banks the capped refund on regtest and the plain sum on mainnet', async function () {
            const armed = deployRun(0);
            await applyConstructorEffects(deployHandler('regtest'), armed);
            assert.strictEqual(armed.nestedGasUnused, 100);
            const legacy = deployRun(900000);
            await applyConstructorEffects(deployHandler('mainnet'), legacy);
            assert.strictEqual(legacy.nestedGasUnused, 140);
        });
    });
});

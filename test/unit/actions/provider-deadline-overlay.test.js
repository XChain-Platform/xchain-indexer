// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { getTestConfig } = require('../../fixtures/config');

const Execute = require('../../../src/actions/execute.js');
const Deploy  = require('../../../src/actions/deploy.js');

// : the deadline-window map injected into the VM gateway was built from an
// UNCONFIGURED ProviderRegistry, so it only ever carried the built-in DEFAULTS while
// attest.js validated the same deadlines against the CONFIGURED registry. Under an
// ATTESTATION.PROVIDERS overlay the VM would accept an attestation.request() the
// indexer then rejects, which is a validator-level accept/reject split. These tests
// pin the injected map to the overlay so the two sides cannot drift again.
describe('Provider deadline-window overlay parity (VM injection) @regression @tier2', function () {

    const SOURCE   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const CONTRACT = 5;

    // A full, self-describing provider definition: the registry REPLACES a default
    // entry wholesale rather than field-merging, so a partial override is not valid.
    const OVERLAY = {
        http_get: {
            provider_id:            'http_get',
            version:                1,
            consensus_strategy:     'byte_equality',
            max_request_bytes:      2048,
            max_response_bytes:     32768,
            allowed_redundancy:     [1, 3, 5],
            deadline_window_blocks: 7
        },
        weather: {
            provider_id:            'weather',
            version:                1,
            consensus_strategy:     'byte_equality',
            max_request_bytes:      1024,
            max_response_bytes:     4096,
            allowed_redundancy:     [1],
            deadline_window_blocks: 13
        }
    };

    function overlayConfig() {
        const config = getTestConfig();
        config['GAS_PRICE'] = '0';   // fee = 0 → skip the gas-balance validation
        config['ATTESTATION'] = { PROVIDERS: OVERLAY };
        return config;
    }

    afterEach(function () {
        sinon.restore();
    });

    it('EXECUTE injects the CONFIGURED deadline windows into the VM', async function () {
        const indexer = createMockIndexer({ config: overlayConfig() });
        const db = indexer.indexerDb;
        db.getContract             = sinon.stub().resolves({ contract_index: CONTRACT, code: 'module.exports={}', status_id: 1 });
        db.getContractPermissions  = sinon.stub().resolves(null);
        db.getStatusString         = sinon.stub().resolves('valid');
        db.getContractState        = sinon.stub().resolves({});
        db.getOracleDataForVM      = sinon.stub().resolves({});
        db.getCrossChainDataForVM  = sinon.stub().resolves({});
        db.getPollResultsForVM     = sinon.stub().resolves({ polls: {} });
        db.getContractStakeDataForVM = sinon.stub().resolves({});
        db.getAttestationDataForVM = sinon.stub().resolves({ responses: {} });
        db.createContractExecution = sinon.stub().resolves();
        db.createContractState     = sinon.stub().resolves();
        db.createContractEmission  = sinon.stub().resolves();
        db.createSavepoint         = sinon.stub().resolves('sp1');
        db.releaseSavepoint        = sinon.stub().resolves();
        db.rollbackToSavepoint     = sinon.stub().resolves();
        db.isActionAllowed.resolves(true);
        db.getTokenInfo.resolves({ TICK_ID: 1 });
        db.getAddressBalances.resolves({ 1: '1000000' });

        const vm = { execute: sinon.stub().resolves({
            success: true, gasUsed: 100, stateChanges: [], stateDeletes: [], emittedActions: []
        }) };

        const handler = new Execute({
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: indexer.protocolChanges,
            vm:        vm
        });
        indexer.util.resetLists();

        const data = createBaseData({ ACTION: 'EXECUTE', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
        await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);

        assert.ok(vm.execute.called, 'the VM was never invoked, so the injected map was not exercised');
        const injected = vm.execute.firstCall.args[0].providerDeadlines;
        assert.strictEqual(injected.http_get, 7,  'overridden provider window must reach the VM');
        assert.strictEqual(injected.weather,  13, 'config-registered provider must reach the VM');
        assert.strictEqual(injected.llm,      20, 'un-overridden default must survive the overlay');
    });

    it('DEPLOY injects the CONFIGURED deadline windows into the VM', async function () {
        const indexer = createMockIndexer({ config: overlayConfig() });
        const db = indexer.indexerDb;
        db.createContract           = sinon.stub().resolves();
        db.createContractPermission = sinon.stub().resolves();
        db.deleteContract           = sinon.stub().resolves();
        db.createContractExecution  = sinon.stub().resolves();
        db.createContractState      = sinon.stub().resolves();
        db.createSavepoint          = sinon.stub().resolves('sp1');
        db.releaseSavepoint         = sinon.stub().resolves();
        db.rollbackToSavepoint      = sinon.stub().resolves();
        db.getOracleDataForVM       = sinon.stub().resolves({});
        db.getCrossChainDataForVM   = sinon.stub().resolves({});
        db.getPollResultsForVM      = sinon.stub().resolves({ polls: {} });
        db.getStatusString          = sinon.stub().resolves('valid');
        db.isActionAllowed.resolves(true);
        db.getTokenInfo.resolves({ TICK_ID: 1 });
        db.getAddressBalances.resolves({ 1: '1000000' });

        const vm = {
            validateSyntax:     sinon.stub().returns({ valid: true }),
            checkFloatWarnings: sinon.stub().returns([]),
            readManifest:       sinon.stub().resolves({ success: true, manifest: null, error: null }),
            execute:            sinon.stub().resolves({
                success: true, gasUsed: 0, stateChanges: [], stateDeletes: [], emittedActions: []
            })
        };

        const handler = new Deploy({
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: { isEnabled: sinon.stub().resolves(true) },
            vm:        vm
        });
        indexer.util.resetLists();

        // CONSTRUCTOR_PARAMS must be non-empty (or the code must export initialize) or
        // deploy.js skips the constructor VM run entirely and nothing is injected.
        const code = Buffer.from('module.exports = { initialize: function() { return 1; } };', 'utf8').toString('base64');
        const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
        await handler.parse(['0', code, '100000', 'seed'], data, null);

        assert.ok(vm.execute.called, 'the VM was never invoked, so the injected map was not exercised');
        const injected = vm.execute.firstCall.args[0].providerDeadlines;
        assert.strictEqual(injected.http_get, 7,  'overridden provider window must reach the VM');
        assert.strictEqual(injected.weather,  13, 'config-registered provider must reach the VM');
        assert.strictEqual(injected.llm,      20, 'un-overridden default must survive the overlay');
    });

});

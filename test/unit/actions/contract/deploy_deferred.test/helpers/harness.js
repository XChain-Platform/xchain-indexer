// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const crypto = require('crypto');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../../../../fixtures/mocks');
const { getTestConfig } = require('../../../../../fixtures/config');
const Deploy = require('../../../../../../src/actions/deploy/index.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const CODE   = 'module.exports = { initialize: function() { return 1; } };';
const B64    = Buffer.from(CODE, 'utf8').toString('base64');
const HASH   = crypto.createHash('sha256').update(CODE).digest('hex');

// The assembler's stored rows, as db.getPendingDeployAssembler returns them. gas_limit /
// input_params come from its contract_executions row, the staking pair from its contracts row.
function assemblerRow(overrides = {}){
    return {
        action_index: 700, block_index: 100, code_hash: HASH,
        cooldown_blocks: null, slash_destination_id: null,
        gas_limit: 100000, input_params: 'x', fee_payment_mode: 2,
        ...overrides
    };
}

function carrierChunk(overrides = {}){
    return { chunk_index: 0, total_chunks: 1, code_part: B64, action_index: 902, ...overrides };
}

// gateOn / balance / chunkRows / pendingAssembler are the four axes every case moves.
// scheduleOverrides is a fifth, narrow one: the gas-parity test neutralizes
// VM_DEPLOY_PER_BYTE so DEPLOY_INLINE collapses to the same base DEPLOY_CHUNKED always
// charges. Reassigned on THIS call's own config object only (never mutated in place),
// since src/coins/to_indexer_config.js hands every getConfig() call the SAME cached
// GAS_SCHEDULE object and an in-place edit would leak into every other test file.
function buildHarness({ gateOn = true, balance = '1000', chunkRows = [], pendingAssembler = null,
                        ctorGas = 5000, scheduleOverrides = null } = {}){
    const config = getTestConfig();
    if(scheduleOverrides) config['GAS_SCHEDULE'] = Object.assign({}, config['GAS_SCHEDULE'], scheduleOverrides);
    const indexer = createMockIndexer({ config });
    const db = indexer.indexerDb;
    for(const m of ['createContract','createContractPermission','deleteContract','createContractExecution',
                    'createContractState','releaseSavepoint','rollbackToSavepoint','recordDeployChunk','createAddress'])
        db[m] = sinon.stub().resolves();
    db.createSavepoint = sinon.stub().resolves('sp1');
    db.getOracleDataForVM = sinon.stub().resolves({});
    db.getCrossChainDataForVM = sinon.stub().resolves({});
    db.getPollResultsForVM = sinon.stub().resolves({ polls: {} });
    db.getStatusString = sinon.stub().resolves('valid');
    db.getAddressById = sinon.stub().resolves(null);
    db.isActionAllowed.resolves(true);
    db.getTokenInfo.resolves({ TICK_ID: 1 });
    db.getAddressBalances.resolves({ 1: balance });
    // The assembly bound is honoured for real: rows at or above `before` are not returned,
    // which is what makes the C + 1 bound observable.
    db.getDeployChunksForAssembly = sinon.stub().callsFake(async (src, hash, before) =>
        chunkRows.filter(r => Number(r.action_index) < Number(before)));
    db.getPendingDeployAssembler = sinon.stub().resolves(pendingAssembler);

    const isEnabled = sinon.stub().resolves(true);
    isEnabled.withArgs('DEPLOY_DEFERRED_ASSEMBLY', sinon.match.any).resolves(gateOn);
    // Capture each ledger write of this action BEFORE consolidation, so a split write is
    // visible as two entries rather than hiding inside one consolidated row.
    const ledgerWrites = [];
    const realLedger = indexer.util.processTransactionLedgerChanges.bind(indexer.util);
    indexer.util.processTransactionLedgerChanges = async (d, data, credits, debits, escrows) => {
        ledgerWrites.push({ action: String(data['ACTION_INDEX']), debits: debits.map(x => x.slice()) });
        return realLedger(d, data, credits, debits, escrows);
    };
    const ctx = makeContext(indexer, db, isEnabled, ctorGas);
    indexer.util.resetLists();
    return { indexer, ctx, db, handler: new Deploy(ctx), ledgerWrites };
}

function makeContext(indexer, db, isEnabled, ctorGas) {
    return {
        config: indexer.config, util: indexer.util, mapper: indexer.mapper,
        decoderDb: indexer.decoderDb, indexerDb: db,
        protocolChanges: { isEnabled },
        vm: {
            validateSyntax: sinon.stub().returns({ valid: true }),
            checkFloatWarnings: sinon.stub().returns([]),
            // CONTRACT_META_REQUIRED is genesis-active on regtest, so the stubbed manifest must
            // carry a conforming meta or every deploy here reads 'meta required'.
            readManifest: sinon.stub().resolves({ success: true, manifest: { hasInitialize: true, permissionsType: 'undefined', maxTakeBpsType: 'undefined', metaType: 'object', metaJson: JSON.stringify({ name: 'Unit Fixture', description: 'A unit-test contract fixture.', version: '1.0.0' }), metaError: false, metaOversize: false } }),
            execute: sinon.stub().resolves({ success: true, gasUsed: ctorGas, stateChanges: [], stateDeletes: [], emittedActions: [] })
        }
    };
}

function assemblerData(overrides = {}){
    return createBaseData({ ACTION: 'DEPLOY', FORMAT: 2, SOURCE, BLOCK_INDEX: 100, ACTION_INDEX: 700, ...overrides });
}

function carrierData(overrides = {}){
    return createBaseData({ ACTION: 'DEPLOY', FORMAT: 4, SOURCE, BLOCK_INDEX: 100, ACTION_INDEX: 902, ...overrides });
}

module.exports = { B64, CODE, HASH, assemblerRow, carrierChunk, buildHarness, assemblerData, carrierData };

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The shared fixture of the EXECUTE suites, execute.test.js and the parts in
// execute.test/: each suite rebuilds its handler through buildExecute() before
// every test, so every same-title sibling block starts from the same state.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../../../fixtures/mocks');
const { getTestConfig } = require('../../../../fixtures/config');

const Execute = require('../../../../../src/actions/execute/index.js');

const SOURCE   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const CONTRACT = 5;

function addExecuteStubs(db) {
    // The stored source of a contract that deployed at/after CONTRACT_META_REQUIRED
    // always carries `meta`, so the fixture does too. The EXECUTE path
    // never re-evaluates meta (the verdict lives in actions/deploy/index.js alone), so this
    // is fixture realism, not a behaviour this suite asserts.
    db.getContract             = sinon.stub().resolves({ contract_index: CONTRACT, code: "module.exports={meta:{name:'Execute Fixture',description:'A unit-test contract fixture.',version:'1.0.0'}}", status_id: 1 });
    db.getContractPermissions  = sinon.stub().resolves(null);   // Phase E: no manifest → unrestricted
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
}

function makeVm(overrides = {}) {
    return {
        execute: sinon.stub().resolves({
            success:        true,
            gasUsed:        100,
            stateChanges:   [],
            stateDeletes:   [],
            emittedActions: [],
        }),
        ...overrides,
    };
}

function executeData(overrides = {}) {
    return createBaseData({ ACTION: 'EXECUTE', FORMAT: 0, SOURCE, BLOCK_INDEX: 100, ...overrides });
}

/** A fresh mock indexer, its actions context and an EXECUTE handler over it. */
function buildExecute() {
    const config = getTestConfig();
    config['GAS_PRICE'] = '0'; // fee = 0 → skip gas-balance validation

    const indexer = createMockIndexer({ config });
    addExecuteStubs(indexer.indexerDb);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });

    const actionsCtx = {
        config:    indexer.config,
        util:      indexer.util,
        mapper:    indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        // EXECUTE now fails CLOSED (EXECUTOR_UNAVAILABLE host fault) without a
        // VM, so the default ctx carries a permissive stub; the fail-closed
        // describe in execute.test.js drops it to exercise the gate.
        vm: makeVm(),
    };
    const handler = new Execute(actionsCtx);
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

module.exports = { SOURCE, CONTRACT, addExecuteStubs, makeVm, executeData, buildExecute };

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Shared fixtures of the DEPLOY meta-verdict suite:
 * test/unit/actions/deploy_contract_meta.test.js and the parts beside it in
 * deploy_contract_meta.test/.
 *
 * The suite is one describe title spread over several files, so the meta
 * report mirror, the stubs and deployWith() live here once. deployWith() reads
 * the fixtures of the test running now, which freshMetaSuite() (the body of the
 * suite's beforeEach) sets before each test and also hands back to the part.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../../../fixtures/mocks');
const { getTestConfig } = require('../../../../fixtures/config');

const Deploy = require('../../../../../src/actions/deploy/index.js');

const VALID_CODE     = 'module.exports = { run: function() { return 1; } };';
const VALID_CODE_B64 = Buffer.from(VALID_CODE, 'utf8').toString('base64');

const GOOD_META = { name: 'Escrow', description: 'Two-party escrow with an arbiter', version: '1.0.0' };

// Mirror of the xchain-vm CONTRACT_WRAPPER meta report: the isolate decides
// metaType, serialises inside the isolate, and caps at 4096 UTF-16 code units.
function metaReportFor(meta) {
    if (meta === undefined)
        return { metaType: 'undefined', metaJson: null, metaError: false, metaOversize: false };
    const metaType = meta === null ? 'null' : (Array.isArray(meta) ? 'array' : typeof meta);
    if (metaType !== 'object')
        return { metaType, metaJson: null, metaError: false, metaOversize: false };
    let json = null, metaError = false, metaOversize = false;
    try { json = JSON.stringify(meta); } catch (e) { metaError = true; }
    if (json !== null && json.length > 4096) { metaOversize = true; json = null; }
    if (json !== null && json.charAt(0) !== '{') { metaError = true; json = null; }
    return { metaType, metaJson: json, metaError, metaOversize };
}

function manifestFor(meta, overrides = {}) {
    return Object.assign({
        permissions: null, permissionsType: 'undefined',
        maxTakeBps:  null, maxTakeBpsType:  'undefined',
        hasInitialize: false
    }, metaReportFor(meta), overrides);
}

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
// The fixtures of the test running now: set by freshMetaSuite(), read by deployWith().
let indexer, actionsCtx;

function addDeployStubs(db) {
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
}

function makeVm(read) {
    return {
        validateSyntax:     sinon.stub().returns({ valid: true }),
        checkFloatWarnings: sinon.stub().returns([]),
        readManifest:       sinon.stub().resolves(read),
        execute:            sinon.stub().resolves({
            success: true, gasUsed: 0, stateChanges: [], stateDeletes: [], emittedActions: []
        })
    };
}

// Drive one DEPLOY through the real handler with the given raw readManifest result.
// metaEnabled=false models a block below the flag day.
async function deployWith(read, metaEnabled = true) {
    const isEnabled = sinon.stub().resolves(true);
    if (!metaEnabled)
        isEnabled.withArgs('CONTRACT_META_REQUIRED', sinon.match.any).resolves(false);
    actionsCtx.protocolChanges = { isEnabled };
    actionsCtx.vm = makeVm(read);
    const handler = new Deploy(actionsCtx);
    const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
    await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
    return { status: data['STATUS'], createContract: indexer.indexerDb.createContract };
}

// The common case: a successful read of a manifest carrying `meta`.
function readOf(meta, overrides) {
    return { success: true, manifest: manifestFor(meta, overrides), error: null };
}

function metaArgs(stub) {
    assert.ok(stub.calledOnce, 'createContract must be called exactly once');
    const row = stub.firstCall.args[0];
    return {
        META_NAME: row.META_NAME, META_DESCRIPTION: row.META_DESCRIPTION,
        META_VERSION: row.META_VERSION, META_JSON: row.META_JSON
    };
}

// The body of the suite's beforeEach: a fresh mock indexer with the DEPLOY
// stubs and a handler context whose VM reads a conforming meta.
function freshMetaSuite() {
    const config = getTestConfig();
    config['GAS_PRICE'] = '0';
    indexer = createMockIndexer({ config });
    addDeployStubs(indexer.indexerDb);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
    actionsCtx = {
        config: indexer.config, util: indexer.util, mapper: indexer.mapper,
        decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
        protocolChanges: { isEnabled: sinon.stub().resolves(true) },
        vm: makeVm(readOf(GOOD_META))
    };
    indexer.util.resetLists();
    return { indexer, actionsCtx };
}

module.exports = {
    VALID_CODE_B64, GOOD_META, SOURCE,
    manifestFor, makeVm, deployWith, readOf, metaArgs, freshMetaSuite,
};

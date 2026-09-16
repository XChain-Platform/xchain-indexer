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
 * Shared fixtures of the DEPLOY unit suite: test/unit/actions/contract/deploy.test.js
 * and the parts beside it in deploy.test/.
 *
 * The suite is one describe title spread over several files, so the database
 * stubs, the default VM, the conforming meta and the per-test setup live here
 * once instead of being copied into every part. freshDeploySuite() is the body
 * of the suite's beforeEach: every block calls it before each test and gets a
 * new mock indexer, handler context and DEPLOY handler back.
 */

'use strict';

const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../../../../fixtures/mocks');
const { getTestConfig } = require('../../../../../fixtures/config');

const Deploy = require('../../../../../../src/actions/deploy/index.js');

// Minimal valid JS contract code (base64-encoded)
const VALID_CODE    = 'module.exports = { run: function() { return 1; } };';
const VALID_CODE_B64 = Buffer.from(VALID_CODE, 'utf8').toString('base64');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

function addDeployStubs(db) {
    db.createContract          = sinon.stub().resolves();
    db.createContractPermission = sinon.stub().resolves();   // Phase E manifest persistence
    db.deleteContract          = sinon.stub().resolves();
    db.createContractExecution = sinon.stub().resolves();
    db.createContractState     = sinon.stub().resolves();
    db.createSavepoint         = sinon.stub().resolves('sp1');
    db.releaseSavepoint        = sinon.stub().resolves();
    db.rollbackToSavepoint     = sinon.stub().resolves();
    db.getOracleDataForVM      = sinon.stub().resolves({});
    db.getCrossChainDataForVM  = sinon.stub().resolves({});
    db.getPollResultsForVM     = sinon.stub().resolves({ polls: {} });
    db.getStatusString         = sinon.stub().resolves('valid');
}

// CONTRACT_META_REQUIRED is genesis-active on regtest (the INDEXER_NETWORK every file of this suite sets)
// and this suite's isEnabled stub resolves true, so every default deploy must read a
// CONFORMING meta or it lands 'invalid: CONTRACT_MANIFEST (...)' instead of 'valid'.
// A manifest of null is the (manifest read failed) verdict, not "no manifest", so the
// default report is now a full one that declares nothing but its identity.
const CONFORMING_META = {
    name:        'Unit Fixture',
    description: 'A contract used by the deploy unit suite.',
    version:     '1.0.0'
};
function metaFields(meta = CONFORMING_META) {
    return {
        metaType:     'object',
        metaJson:     JSON.stringify(meta),
        metaError:    false,
        metaOversize: false
    };
}
function baseManifest(hasInitialize = false) {
    return Object.assign({
        permissions: null, permissionsType: 'undefined',
        maxTakeBps:  null, maxTakeBpsType:  'undefined',
        hasInitialize
    }, metaFields());
}

function makeVm(overrides = {}) {
    return {
        validateSyntax:    sinon.stub().returns({ valid: true }),
        checkFloatWarnings:sinon.stub().returns([]),
        // Phase E: by default a contract declares no permissions manifest
        // (permissionsType 'undefined' → unrestricted), so deploy behaves as
        // pre-Phase-E, and it carries the meta the flag day requires.
        readManifest:      sinon.stub().resolves({ success: true, manifest: baseManifest(), error: null }),
        execute:           sinon.stub().resolves({
            success:      true,
            gasUsed:      0,
            stateChanges: [],
            stateDeletes: [],
            emittedActions: [],
        }),
        ...overrides,
    };
}

function deployData(overrides = {}) {
    return createBaseData({ ACTION: 'DEPLOY', FORMAT: 0, SOURCE, BLOCK_INDEX: 100, ...overrides });
}

// The body of the suite's beforeEach: a fresh mock indexer with the DEPLOY
// stubs, a handler context on a post-activation node, and a DEPLOY handler.
function freshDeploySuite() {
    let indexer, actionsCtx, handler;
    const config = getTestConfig();
    config['GAS_PRICE'] = '0'; // fee = 0 → skip balance check in most tests

    indexer = createMockIndexer({ config });
    addDeployStubs(indexer.indexerDb);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });

    actionsCtx = {
        config:    indexer.config,
        util:      indexer.util,
        mapper:    indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        // Inline DEPLOY decode is gated on DEPLOY_BASE64_CODE; base64 at/after the
        // activation, hex before. Default the stub to enabled (base64) so the existing
        // base64-fixture tests below behave as on a post-activation node; the gate
        // describe block flips it to false to exercise the pre-activation hex path.
        protocolChanges: { isEnabled: sinon.stub().resolves(true) },
        // deploy now fails CLOSED (EXECUTOR_UNAVAILABLE host fault) without a VM,
        // so the default ctx carries a permissive stub; gate-specific tests override.
        vm: makeVm(),
    };
    handler = new Deploy(actionsCtx);
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

module.exports = {
    VALID_CODE, VALID_CODE_B64, SOURCE,
    addDeployStubs, baseManifest, makeVm, deployData, freshDeploySuite,
};

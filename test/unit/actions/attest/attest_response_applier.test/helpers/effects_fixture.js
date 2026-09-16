// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The per-test handler and the synthesized-action data the §4.4 effects suites
// (attest_response_applier.test/effects_*.test.js) run against, one copy for
// every sibling block.

'use strict';

const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../../../../fixtures/mocks');

const Attest   = require('../../../../../../src/actions/attest/index.js');
const swq     = require('../../../../../../src/consensus/stake_weighted_quorum.js');
const { stubActiveAt } = require('../../../../../helpers/gate_modules.js');
const attestBcastFee  = require('../../../../../../src/actions/attest/attest_broadcast_fee_gate.js');
const ed25519 = require('../../../../../../src/consensus/ed25519.js');

const { PUBKEY_A, REQ_ID, BLOCK_TIME, mirrorRow, requestRow } = require('./rows.js');

function addAttestationDbStubs(db) {
    db.getAttestationRequestById         = sinon.stub().resolves(null);
    db.hasCapability                     = sinon.stub().resolves(true);
    db.createAttestationResponse         = sinon.stub().resolves();
    db.incrementAttestationValidatorStat = sinon.stub().resolves();
    db.updateAttestationRequestStatus    = sinon.stub().resolves();
    db.setAttestationResponseCallbackIndex = sinon.stub().resolves();
    db.getValidatorsByCapability         = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
    db.getStakeWeightsByCapability       = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'SA', weight: '100' }]);
    db.createValidatorReward             = sinon.stub().resolves(true);
    db.createSavepoint                   = sinon.stub().resolves('sp1');
    db.releaseSavepoint                  = sinon.stub().resolves();
    db.rollbackToSavepoint               = sinon.stub().resolves();
    db.createActionIndex                 = sinon.stub().resolves(4242);
}

// The data object utility.processAttestationResponses hands the handler.
function applyData(overrides = {}, rowOverrides = {}, requestOverrides = {}) {
    return createBaseData({
        ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, BLOCK_TIME: BLOCK_TIME,
        TX_INDEX: null, TX_VOUT: null, TX_HASH: undefined, ACTION_INDEX: undefined,
        IS_SYNTHETIC: true,
        MIRROR_RESPONSE: mirrorRow(rowOverrides),
        MIRROR_REQUEST:  requestRow(requestOverrides),
        REQUEST_ID: REQ_ID,
        ...overrides,
    });
}

/**
 * A fresh handler over a mock indexer with the attestation DB stubbed and the
 * quorum, admission and broadcast-fee flag days held off, built in each effects
 * block's beforeEach; the block's afterEach restores it with sinon.restore().
 * @returns {{indexer, actionsCtx, handler, executeStub}}
 */
function setupEffects() {
    const indexer = createMockIndexer();
    addAttestationDbStubs(indexer.indexerDb);
    const executeStub = { parse: sinon.stub().resolves() };
    const actionsCtx = {
        config:        indexer.config,
        util:          indexer.util,
        mapper:        indexer.mapper,
        decoderDb:     indexer.decoderDb,
        indexerDb:     indexer.indexerDb,
        actionExecute: executeStub,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
    };
    const handler = new Attest(actionsCtx);
    indexer.util.resetLists();
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    stubActiveAt(sinon, 'attest_admission_activation.ATTEST_ADMISSION_ACTIVATION', false);
    sinon.stub(attestBcastFee, 'isAttestBroadcastFeeActive').returns(false);
    sinon.stub(ed25519, 'verify').returns(true);
    return { indexer, actionsCtx, handler, executeStub };
}

module.exports = { applyData, setupEffects };

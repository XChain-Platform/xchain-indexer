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
// Shared fixture for the cross-chain relay suites: the wire builders, the
// origin-side request row, and the per-test handler setup that
// test/unit/actions/attest_relay.test.js and every part beside it in
// attest_relay.test/ run from their beforeEach hooks. One copy, so a stub
// added for one leg cannot silently diverge from the stubs another leg runs on.

'use strict';

const sinon  = require('sinon');

const { createMockIndexer } = require('../../../../fixtures/mocks');

const Attest       = require('../../../../../src/actions/attest/index.js');
const swq          = require('../../../../../src/consensus/stake_weighted_quorum.js');
// The relay and response-mirror flag days are registry rows (W5), stubbed through
// activeAt() by their keys.
const { stubActiveAt, stubGate } = require('../../../../helpers/gate_modules.js');
const RELAY_KEY = 'attest_relay_activation.ATTEST_RELAY_ACTIVATION';
const RESPONSE_MIRROR_KEY = 'attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION';
const ed25519      = require('../../../../../src/consensus/ed25519.js');

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const SIG_A    = '1'.repeat(128);
const SIG_B    = '2'.repeat(128);
const REQ_ID   = 'd'.repeat(64);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Positional wire builders. Written out longhand rather than generated so a field
// reorder in the handler shows up here as a failing assertion instead of being
// mirrored silently by a shared helper.
function v3Params(o = {}) {
    return [
        3,
        o.requestId      !== undefined ? o.requestId      : REQ_ID,
        o.originChain    !== undefined ? o.originChain    : 'LTC',
        o.originAction   !== undefined ? o.originAction   : 4242,
        o.providerId     !== undefined ? o.providerId     : 'http_get',
        o.payload        !== undefined ? o.payload        : 'https://example.com/score',
        o.redundancy     !== undefined ? o.redundancy     : 1,
        o.deadlineBlocks !== undefined ? o.deadlineBlocks : 10,
        o.snapshotBlock  !== undefined ? o.snapshotBlock  : 100,
        ...(o.sigTail !== undefined ? o.sigTail : [1, PUBKEY_A, SIG_A]),
    ];
}

function v4Params(o = {}) {
    return [
        4,
        o.requestId       !== undefined ? o.requestId       : REQ_ID,
        o.homeResponseIdx !== undefined ? o.homeResponseIdx : 777,
        o.payloadB64      !== undefined ? o.payloadB64      : b64('{"winner":"home"}'),
        o.status          !== undefined ? o.status          : 'ok',
        o.meta            !== undefined ? o.meta            : '200',
        o.snapshotBlock   !== undefined ? o.snapshotBlock   : 100,
        ...(o.sigTail !== undefined ? o.sigTail : [1, PUBKEY_A, SIG_A]),
    ];
}

function addAttestationDbStubs(db) {
    db.getContract                         = sinon.stub().resolves({ contract_index: 5 });
    db.createAttestationRequest            = sinon.stub().resolves();
    db.getAttestationAdmissionCounts = sinon.stub().resolves({ total: 0, byContract: 0 });
    db.getAttestationRequestById           = sinon.stub().resolves(null);
    db.getRelayRequestById                 = sinon.stub().resolves(null);
    db.getRelayRequestByOrigin             = sinon.stub().resolves(null);
    db.hasCapability                       = sinon.stub().resolves(true);
    db.createAttestationResponse           = sinon.stub().resolves();
    db.incrementAttestationValidatorStat   = sinon.stub().resolves();
    db.updateAttestationRequestStatus      = sinon.stub().resolves();
    db.setAttestationResponseCallbackIndex = sinon.stub().resolves();
    db.getValidatorsByCapability           = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
    db.getStakeWeightsByCapability         = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'SA', weight: '100' }]);
    db.createValidatorReward               = sinon.stub().resolves(true);
    db.createActionIndex                   = sinon.stub().resolves(999);
    db.createSavepoint                     = sinon.stub().resolves('sp1');
    db.releaseSavepoint                    = sinon.stub().resolves();
    db.rollbackToSavepoint                 = sinon.stub().resolves();
    db.getTokenDecimalPrecision            = sinon.stub().resolves(8);
    db.getTickerId                         = sinon.stub().resolves(1);
}

// An origin-side v0 row that this chain admitted for relay.
function originRequestRow(overrides = {}) {
    return {
        request_id:           REQ_ID,
        provider_id:          'http_get',
        request_status:       'pending',
        deadline_block:       500,
        block_index:          3160000,      // an LTC local height, deliberately huge
        action_index:         4242,
        redundancy:           1,
        contract_index:       5,
        callback_method:      'onResult',
        callback_params_json: '[]',
        origin_chain:         'LTC',
        fee_amount:           null,
        ...overrides,
    };
}

/**
 * The per-test handler every relay suite runs against, built fresh in each
 * beforeEach; the suite's afterEach restores the stubs with sinon.restore().
 * @returns {{indexer, actionsCtx, handler, executeStub, gateStub, protocolGates}}
 */
function setupRelay() {
    const indexer = createMockIndexer();
    addAttestationDbStubs(indexer.indexerDb);
    const executeStub = { parse: sinon.stub().resolves() };

    // Per-name protocol-change control. A blanket `resolves(true)` would hide the
    // ATTEST_RELAY_ORIGIN gate, which is one of the two things under test.
    const protocolGates = { ATTEST_RELAY_ORIGIN: true };
    const actionsCtx = {
        config:        indexer.config,
        util:          indexer.util,
        mapper:        indexer.mapper,
        decoderDb:     indexer.decoderDb,
        indexerDb:     indexer.indexerDb,
        actionExecute: executeStub,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().callsFake(async (name) =>
                protocolGates[name] !== undefined ? protocolGates[name] : true),
        },
    };
    const handler = new Attest(actionsCtx);
    indexer.util.resetLists();

    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    // The response-mirror flag day, which regtest arms at genesis: at and above it an
    // on-chain ATTEST v1 is refused outright, and two cases here fulfil a relayed
    // request with exactly that wire. The relay legs themselves are untouched by that
    // era, so these fixtures run below it (attest.test.js owns the gate's own cases).
    stubActiveAt(sinon, RESPONSE_MIRROR_KEY, false);
    // Signature verification is stubbed: these tests are about the relay's
    // structure and gating, not about ed25519 itself.
    sinon.stub(ed25519, 'verify').returns(true);
    // Gate ON by default; the inertness describe drives it OFF explicitly.
    const gateStub = stubGate(sinon, RELAY_KEY, true);

    return { indexer, actionsCtx, handler, executeStub, gateStub, protocolGates };
}

module.exports = {
    PUBKEY_A, PUBKEY_B, SIG_A, SIG_B, REQ_ID,
    b64, v3Params, v4Params, originRequestRow, setupRelay,
};

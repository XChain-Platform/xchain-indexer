// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Shared fixtures of the ATTEST handler suite (test/unit/actions/attest.test.js and
// test/unit/actions/attest.test/). The suite was one file whose outer describe held this
// setup; it lives here now so every part builds the handler exactly the same way.

const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');

const Attest          = require('../../src/actions/attest/index.js');
const swq             = require('../../src/stake_weighted_quorum.js');
const { stubActiveAt } = require('./gate_modules.js');
const attestBcastFee  = require('../../src/actions/attest/attest_broadcast_fee_gate.js');
const arm             = require('../../src/attest_response_mirror_activation.js');
// Same module instance Attest holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519         = require('../../src/consensus/ed25519.js');

// 64-hex pubkeys / 128-hex sigs (format-valid; verification is stubbed)
const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const SIG_A    = '1'.repeat(128);
const SIG_B    = '2'.repeat(128);
const REQ_ID   = 'd'.repeat(64);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Mirror the handler's deterministic request_id derivation:
//   sha256(tx_hash + ':' + root_action_index + ':' + emitter_path + ':' + contract_index + ':' + emitter_position)
// ROOT_ACTION_INDEX (the per-root discriminator = the deterministic root on-chain
// action_index) is inserted immediately after tx_hash. The emitter call-path
// ('>'-joined per-execution emission positions, root = '') disambiguates nested
// cross-contract runs of the same contract within one tx and is content-derived
// (byte-stable across nodes/reorgs). MUST byte-match xchain-vm/src/gateway.js.
// A legitimate VM emission always supplies a REQUEST_ID equal to this digest.
const deriveReqId = (txHash, rootActionIndex, emitterPath, contractIndex, position) =>
    crypto.createHash('sha256')
        .update(String(txHash) + ':' + String(rootActionIndex) + ':' + String(emitterPath) + ':' + String(contractIndex) + ':' + String(position))
        .digest('hex');

// Cross-repo golden pin for the request_id preimage. This is the checked-in
// (input tuple -> expected hex) vector from xchain-vm/src/gateway_emit.js
// (GOLDEN_VECTORS.requestId). It is a LITERAL constant on purpose: asserting the
// REAL attest handler against it (below) catches a lockstep field-reorder that
// would otherwise pass because the local deriveReqId copy was reordered too. Keep
// in sync with xchain-vm/src/gateway_emit.js; a mismatch is a genuine fleet fork.
const GOLDEN_REQUEST_ID = {
    input: { txHash: 'abc123', rootActionIndex: 100, emitterPath: '', contractIndex: 7, emitterPosition: 0 },
    // sha256('abc123:100::7:0')
    expected: 'b770a548716259f767c3eb6e9e1e5eb0e3878c9ec3d6bbd68a7e1ab8221fffb7'
};

// Extend the default mock DB with the attestation-specific methods attest.js calls.
function addAttestationDbStubs(db) {
    db.getContract                       = sinon.stub().resolves({ contract_index: 5 });
    db.createAttestationRequest          = sinon.stub().resolves();
    db.getAttestationAdmissionCounts = sinon.stub().resolves({ total: 0, byContract: 0 });
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
}

function makeRequestRow(overrides = {}) {
    return {
        request_id:           REQ_ID,
        provider_id:          'http_get',
        request_status:       'pending',
        deadline_block:       200,
        block_index:          90,        // snapshot block (intentionally < response block)
        redundancy:           1,
        contract_index:       5,
        callback_method:      'onResult',
        callback_params_json: '[]',
        ...overrides,
    };
}

// The suite's outer beforeEach, as one named step: a fresh mock indexer, the
// handler over it, and the genesis-armed gates stubbed back to their legacy side.
// Each part calls it from its own beforeEach and restores sinon after each test.
function setUpAttestHandler() {
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
    // Default to the legacy COUNT path (per-key responsible set). The
    // source-deduped weighted path has its own describe below. (regtest
    // activates weighting at genesis, so this must be stubbed off here.)
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    // Default the Pkg 7 admission gate OFF (legacy accept-then-expire) so the
    // fixtures' redundancy-3 requests against a 1-validator snapshot stay
    // 'valid'; the gate's own describe below re-enables it. (regtest arms the
    // gate at genesis, so this must be stubbed off here, mirroring swq above.)
    stubActiveAt(sinon, 'attest_admission_activation.ATTEST_ADMISSION_ACTIVATION', false);
    // Same treatment for the leader broadcast-fee carve-out: regtest arms it at genesis, so
    // the fixtures above would otherwise settle through the carve-out path and every
    // legacy split assertion would move. Its own describe below re-enables it.
    sinon.stub(attestBcastFee, 'isAttestBroadcastFeeActive').returns(false);
    // And the response-mirror flag day, which regtest also arms at genesis. Above it
    // an on-chain v1 is rejected outright and the broadcast-fee carve-out is retired,
    // so leaving it armed would move every legacy v1 and fee fixture in this file at
    // once. Both eras have their own describes below.
    sinon.stub(arm, 'isResponseMirrorActive').returns(false);
    return { indexer, actionsCtx, handler, executeStub };
}

function v0Data(overrides = {}) {
    // EMITTER_POSITION and EMITTER_PATH are required fields on every
    // legitimate ATTEST v0 emission (set by execute.processEmission); include
    // them by default so the fixture mirrors production. Tests that probe
    // their absence override them back to undefined. EMITTER_PATH '0' models a
    // first-level nested emission; '' (root) is exercised by its own test.
    return createBaseData({
        ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, EMITTER: 5, EMITTER_POSITION: 0,
        EMITTER_PATH: '0', ROOT_ACTION_INDEX: 100, BLOCK_INDEX: 100,
        ...overrides,
    });
}
// VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS
function v0Params(overrides = {}) {
    const p = {
        requestId: REQ_ID, providerId: 'http_get', payload: 'q',
        callback: 'onResult', cbParams: '[]', redundancy: '3', deadline: '50',
        ...overrides,
    };
    return ['0', p.requestId, p.providerId, p.payload, p.callback, p.cbParams, p.redundancy, p.deadline];
}

function v1Data(overrides = {}) {
    return createBaseData({
        ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 7,
        ...overrides,
    });
}
// VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD(b64)|STATUS|META|SIG_COUNT|PUBKEY|SIG|...
function v1Params(sigs, overrides = {}) {
    const p = { requestId: REQ_ID, providerId: 'http_get', payload: b64('hello'), status: 'ok', meta: 'm', ...overrides };
    const head = ['1', p.requestId, p.providerId, p.payload, p.status, p.meta, String(sigs.length)];
    const tail = [];
    for (const s of sigs) { tail.push(s.pubkey, s.sig); }
    return head.concat(tail);
}

// Default: every signature verifies; capability present.
function verifyAllSignatures() {
    sinon.stub(ed25519, 'verify').returns(true);
}

const FEE_PAYER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH'; // createBaseData SOURCE
const POOL      = 'mrewardshQqD1ptkEBZGjPDF77L5uKJQmk'; // config ADDRESS.REWARD (regtest)
const PUBKEY_C  = 'c'.repeat(64);
const SIG_C     = '3'.repeat(128);

function v0FeeData(overrides = {}) {
    return createBaseData({
        ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, EMITTER: 5, EMITTER_POSITION: 0,
        EMITTER_PATH: '0', ROOT_ACTION_INDEX: 100, BLOCK_INDEX: 100, ACTION_INDEX: 40,
        ...overrides,
    });
}
// VERSION|...|DEADLINE_BLOCKS|FEE_TICK|FEE_AMOUNT; reqId derived per fixture
function v0FeeParams(data, feeTick, feeAmount) {
    const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
    const base = ['0', reqId, 'http_get', 'q', 'onResult', '[]', '3', '50'];
    if (feeTick !== undefined)   base.push(feeTick);
    if (feeAmount !== undefined) base.push(feeAmount);
    return base;
}
function feeRequestRow(overrides = {}) {
    return makeRequestRow({
        action_index: 42, fee_amount: '6.00000000', fee_payer: FEE_PAYER,
        ...overrides,
    });
}
function v1FeeData(overrides = {}) {
    return createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60, ...overrides });
}
function v1FeeParams(sigs, status = 'ok') {
    const head = ['1', REQ_ID, 'http_get', b64('hello'), status, 'm', String(sigs.length)];
    const tail = [];
    for (const s of sigs) { tail.push(s.pubkey, s.sig); }
    return head.concat(tail);
}

// cap 0.0001 BTC × (50000 USD/BTC) ÷ (2.5 USD/XCHAIN) = 2 XCHAIN
const COIN_USD   = '50000';
const XCHAIN_USD = '2.5';

module.exports = {
    PUBKEY_A, PUBKEY_B, SIG_A, SIG_B, REQ_ID, b64, deriveReqId, GOLDEN_REQUEST_ID,
    addAttestationDbStubs, makeRequestRow, setUpAttestHandler, verifyAllSignatures,
    v0Data, v0Params, v1Data, v1Params,
    FEE_PAYER, POOL, PUBKEY_C, SIG_C, v0FeeData, v0FeeParams, feeRequestRow, v1FeeData, v1FeeParams,
    COIN_USD, XCHAIN_USD,
};

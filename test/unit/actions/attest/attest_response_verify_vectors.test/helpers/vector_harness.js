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
// The drive harness the ATTEST v1 response-verification vectors share
// (test/unit/actions/attest/attest_response_verify_vectors.test.js and its parts): the
// per-test handler, the capability-read seats, the wire builders, the capture
// drives and the mirror-era module input. The running case's indexer and handler,
// and the canonical the last drive observed, live on `state`, which
// setupVectors() refills from each block's beforeEach.

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../../../../fixtures/mocks');

const Attest  = require('../../../../../../src/actions/attest/index.js');
const avr     = require('../../../../../../src/actions/attest/attest_response_verify.js');
const swq     = require('../../../../../../src/consensus/stake_weighted_quorum.js');
const { stubActiveAt } = require('../../../../../helpers/gate_modules.js');
const attestBcastFee  = require('../../../../../../src/actions/attest/attest_broadcast_fee_gate.js');
// Same module instance the handler (and the extracted verifier) hold: wrapping
// `verify` here observes the exact canonical Buffer both are handed.
const ed25519 = require('../../../../../../src/consensus/ed25519.js');

const {
    JUNK_SIG, REQ_ID_WIRE, REQ_ID_LOWER, DECLARED_BLOCK, BURIED_BLOCK, DEADLINE_BLOCK,
    b64, RANK3, KEY_BY_PUBKEY,
} = require('./vectors.js');

const state = { indexer: null, handler: null, capturedCanonical: null };

function makeRequestRow(overrides = {}) {
    return {
        request_id:           REQ_ID_LOWER,
        provider_id:          'http_get',
        request_status:       'pending',
        deadline_block:       DEADLINE_BLOCK,
        block_index:          DECLARED_BLOCK,
        redundancy:           1,
        contract_index:       5,
        callback_method:      'onResult',
        callback_params_json: '[]',
        ...overrides,
    };
}

/**
 * A fresh handler over a mock indexer, recorded on `state` and returned with it;
 * the calling block's afterEach restores the stubs with sinon.restore().
 */
function setupVectors() {
    const indexer = createMockIndexer();
    const db = indexer.indexerDb;

    db.getContract                       = sinon.stub().resolves({ contract_index: 5 });
    db.createAttestationRequest          = sinon.stub().resolves();
    db.getAttestationAdmissionCounts     = sinon.stub().resolves({ total: 0, byContract: 0 });
    db.getAttestationRequestById         = sinon.stub().resolves(makeRequestRow());
    db.hasCapability                     = sinon.stub().resolves(true);
    db.createAttestationResponse         = sinon.stub().resolves();
    db.incrementAttestationValidatorStat = sinon.stub().resolves();
    db.updateAttestationRequestStatus    = sinon.stub().resolves();
    db.setAttestationResponseCallbackIndex = sinon.stub().resolves();
    db.createValidatorReward             = sinon.stub().resolves(true);
    db.createSavepoint                   = sinon.stub().resolves('sp1');
    db.releaseSavepoint                  = sinon.stub().resolves();
    db.rollbackToSavepoint               = sinon.stub().resolves();

    // Height-sensitive by design (see the header): the set exists at the ONCE-buried
    // height and nowhere else.
    db.getValidatorsByCapability   = sinon.stub().resolves([]);
    db.getStakeWeightsByCapability = sinon.stub().resolves([]);

    const handler = new Attest({
        config:        indexer.config,
        util:          indexer.util,
        mapper:        indexer.mapper,
        decoderDb:     indexer.decoderDb,
        indexerDb:     db,
        actionExecute: { parse: sinon.stub().resolves() },
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
    });
    indexer.util.resetLists();

    // regtest arms every flag-day at genesis; pin the two that would otherwise move
    // a vector's branch out from under it. Each vector re-arms what it needs.
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    stubActiveAt(sinon, 'attest_admission_activation.ATTEST_ADMISSION_ACTIVATION', false);
    sinon.stub(attestBcastFee, 'isAttestBroadcastFeeActive').returns(false);
    // Same treatment for the response-mirror flag day, which regtest also arms at
    // genesis: at and above it the chain handler refuses an on-chain v1 before the
    // verifier is reached at all, so every vector here would record the flag-day
    // verdict instead of the canonical/quorum verdict it exists to pin. These vectors
    // are the LEGACY era's; the gate has its own cases in attest.test.js.
    stubActiveAt(sinon, 'attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION', false);

    state.indexer = indexer;
    state.handler = handler;
    return state;
}

// Seat the unweighted capability set at the once-buried height only.
function seatUnweighted(pubkeys, { truncated = false } = {}) {
    const rows = pubkeys.map(pk => ({ pubkey: pk }));
    if (truncated) rows.truncated = true;
    state.indexer.indexerDb.getValidatorsByCapability = sinon.stub()
        .callsFake(async (cap, block) => (block === BURIED_BLOCK ? rows : []));
}

// Seat the weighted (source-aggregate) set at the once-buried height only. The
// weight clears the http_get provider stake floor; below it the floor filter
// empties the set and the vector would be measuring the floor, not the branch.
function seatWeighted(pubkeys, { truncated = false } = {}) {
    const rows = pubkeys.map((pk, i) => ({ pubkey: pk, source: 'S' + i, weight: '50000' }));
    if (truncated) rows.truncated = true;
    state.indexer.indexerDb.getStakeWeightsByCapability = sinon.stub()
        .callsFake(async (cap, block) => (block === BURIED_BLOCK ? rows : []));
}

function v1Data(overrides = {}) {
    return createBaseData({
        ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 7, ...overrides,
    });
}

function v1Params(sigs, overrides = {}) {
    const p = {
        requestId: REQ_ID_WIRE, providerId: 'http_get', payload: b64('hello'),
        status: 'ok', meta: 'm', ...overrides,
    };
    const head = ['1', p.requestId, p.providerId, p.payload, p.status, p.meta, String(sigs.length)];
    const tail = [];
    for (const s of sigs) tail.push(s.pubkey, s.sig);
    return head.concat(tail);
}

// Drive the real handler once, wrapping ed25519.verify so the canonical the
// implementation actually built is observed rather than reconstructed.
async function driveOnce(sigs, { dataOverrides = {}, paramOverrides = {} } = {}) {
    state.capturedCanonical = null;
    const realVerify = ed25519.verify;
    const wrapped = sinon.stub(ed25519, 'verify').callsFake((payload, sig, pubkey) => {
        state.capturedCanonical = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
        return realVerify(payload, sig, pubkey);
    });
    try {
        const data = v1Data(dataOverrides);
        await state.handler.parse(v1Params(sigs, paramOverrides), data, null);
        return {
            status:       data['STATUS'],
            validSigs:    data['VALID_SIGS'],
            responseHash: data['RESPONSE_HASH'],
            canonical:    state.capturedCanonical,
            signerJson:   data['VALIDATOR_SIGNATURES'],
        };
    } finally {
        wrapped.restore();
    }
}

// Two passes. Pass 1 learns the canonical from the implementation itself using
// throwaway signatures; pass 2 signs THAT string with the real keys and drives
// again. Nothing in the test ever spells the canonical out, so a test that
// agrees with the implementation cannot be agreeing with a shared mistake in a
// duplicated formula.
async function driveSigned(signerPubkeys, opts = {}) {
    const probe = signerPubkeys.map(pk => ({ pubkey: pk, sig: JUNK_SIG }));
    await driveOnce(probe, opts);
    assert.ok(state.capturedCanonical,
        'capture pass produced no canonical: no signature reached the verifier, so this vector proves nothing');
    const learned = state.capturedCanonical;
    const signed = signerPubkeys.map(pk => ({
        pubkey: pk,
        sig: crypto.sign(null, Buffer.from(learned, 'utf8'), KEY_BY_PUBKEY[pk].priv).toString('hex'),
    }));
    return driveOnce(signed, opts);
}

// Same shape as v1Data/v1Params above, but calling the module directly:
// atBlock === declaredBlock (90) keeps the widening ladder at its unwidened
// floor, where RANK3[0] is the sole responsible signer, matching the
// "unwidened" vector in the widening-step block above.
function mirrorInput(effectiveTime, sigs, overrides = {}) {
    return {
        request:           makeRequestRow(),
        sigs,
        requestId:         REQ_ID_LOWER,
        requestIdRaw:      REQ_ID_LOWER,
        providerId:        'http_get',
        responseStatus:    'ok',
        meta:              'm',
        responseBodyBytes: Buffer.from('hello', 'utf8'),
        effectiveTime,
        atBlock:           DECLARED_BLOCK,
        gateBlock:         DECLARED_BLOCK,
        error:             null,
        coin:              'BTC',
        network:           'regtest',
        indexerDb:         state.indexer.indexerDb,
        protocolChanges:   state.handler.actions.protocolChanges,
        computeResponsibleSet: state.handler.computeResponsibleSet.bind(state.handler),
        ...overrides,
    };
}

// Capture the canonical the module actually builds for a given effectiveTime
// (via a throwaway signature; the canonical does not depend on the sigs
// list), then sign THAT string with the real key. Same two-pass technique
// driveSigned uses above, so this vector cannot be agreeing with a
// hand-derived formula that shares the implementation's own mistake.
async function learnCanonical(effectiveTime) {
    const probe = await avr.verifyAttestationResponse(
        mirrorInput(effectiveTime, [{ pubkey: RANK3[0], sig: JUNK_SIG }]));
    assert.ok(probe.canonical, 'probe produced no canonical: nothing to sign');
    return probe.canonical;
}

module.exports = {
    state, makeRequestRow, setupVectors, seatUnweighted, seatWeighted, v1Data, v1Params,
    driveOnce, driveSigned, mirrorInput, learnCanonical,
};

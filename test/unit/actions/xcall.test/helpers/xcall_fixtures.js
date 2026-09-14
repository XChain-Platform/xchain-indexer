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
// The mock XCALL handler, the signing keys and the request/result rows the
// XCALL suite shares (xcall.test.js plus the files in xcall.test/). Every
// block's beforeEach calls freshXcall; the per-behaviour stubs stay in the file
// that uses them.

const crypto = require('crypto');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../../../fixtures/mocks');

const Xcall = require('../../../../../src/actions/xcall/index.js');

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);

// Mirror the handler's deterministic call_id derivation (MUST byte-match)
// xchain-vm/src/gateway_emit.js (crossExecute). emitterPath is the emitting
// execution's '>'-joined call-path (root = ''); it disambiguates two nested runs
// of the same contract and is content-derived (stable across nodes/reorgs).
// ROOT_ACTION_INDEX (the per-root discriminator = the deterministic root on-chain
// action_index) is inserted immediately after txHash in the call_id preimage.
const deriveCallId = (network, chain, txHash, rootActionIndex, contractIndex, emitterPath, position, targetChain) =>
    crypto.createHash('sha256')
        .update([network, chain, txHash, rootActionIndex, contractIndex, emitterPath, position, targetChain].map(String).join(':'))
        .digest('hex');

function addXcallDbStubs(db) {
    db.getContract                        = sinon.stub().resolves({ contract_index: 5 });
    db.createCrossChainCallRequest        = sinon.stub().resolves();
    db.getCrossChainCallRequestById       = sinon.stub().resolves(null);
    db.updateCrossChainCallRequestStatus  = sinon.stub().resolves();
    db.setCrossChainCallCallbackIndex     = sinon.stub().resolves();
    db.recordCrossChainCallCallback       = sinon.stub().resolves();
    db.hasCapability                      = sinon.stub().resolves(true);
    db.getValidatorsByCapability          = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
    // regtest activates STAKE_WEIGHTED_QUORUM at genesis, so processResult takes the
    // stake-weighted branch (getStakeWeightsByCapability + meetsStakeThreshold). One
    // validator = one source: 3·tally(100) > 2·S(100) iff that signer is valid, so the
    // weighted rule reproduces the single-validator legacy outcome these tests assert.
    db.getStakeWeightsByCapability        = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'S1', weight: '100' }]);
    db.createSavepoint                    = sinon.stub().resolves('sp1');
    db.releaseSavepoint                   = sinon.stub().resolves();
    db.rollbackToSavepoint                = sinon.stub().resolves();
}

function makeRequestRow(overrides = {}) {
    return {
        call_id:               'c'.repeat(64),
        contract_index:        5,
        target_chain:          'DOGE',
        target_contract_index: 99,
        method:                'onArrival',
        params_json:           '["x"]',
        gas_limit:             50000,
        cross_hops:            1,
        callback_method:       'onResult',
        callback_params_json:  '["ctx"]',
        deadline_block:        300,
        request_status:        'pending',
        block_index:           100,
        ...overrides,
    };
}

function makeResultRow(overrides = {}) {
    return {
        call_id:              'c'.repeat(64),
        phase:                'result',
        snapshot_block:       150,
        network:              'regtest',
        source_chain:         'BTC',
        target_chain:         'DOGE',
        result_status:        'ok',
        return_payload_b64:   Buffer.from('"42"', 'utf8').toString('base64'),
        effective_time:       1700000000,
        validator_signatures: JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
        ...overrides,
    };
}

// A fresh mock indexer, action context and XCALL handler, rebuilt before every case.
function freshXcall() {
    const indexer = createMockIndexer();
    addXcallDbStubs(indexer.indexerDb);
    const executeStub = { parse: sinon.stub().resolves() };
    const actionsCtx = {
        config:        indexer.config,
        util:          indexer.util,
        mapper:        indexer.mapper,
        decoderDb:     indexer.decoderDb,
        indexerDb:     indexer.indexerDb,
        actionExecute: executeStub,
        // the undeliverable-result retirement paths consult the flag-day
        // gate. Open here (the mock models regtest, genesis-active), so the
        // "nothing recorded" assertions below prove the AGE-OUT clock holds them
        // back, not a closed gate: the request's deadline_block (300) is ahead of
        // the processing block (200), and the result rows are 100s past their
        // effective_time, far inside XCALL_RESULT_ORPHAN_GRACE_SECONDS.
        protocolChanges: indexer.protocolChanges,
    };
    const handler = new Xcall(actionsCtx);
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler, executeStub };
}

function v0Data(overrides = {}) {
    return createBaseData({
        ACTION: 'XCALL', FORMAT: 0, IS_EMISSION: true, EMITTER: 5,
        EMITTER_POSITION: 0, EMITTER_PATH: '0', ROOT_ACTION_INDEX: 100,
        BLOCK_INDEX: 100,
        ...overrides,
    });
}

// VERSION|CALL_ID|TARGET_CHAIN|TARGET_CONTRACT_INDEX|METHOD|PARAMS_JSON|GAS_LIMIT|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|DEADLINE_BLOCKS|CROSS_HOPS
function v0Params(callId, overrides = {}) {
    const p = {
        targetChain: 'DOGE', targetIdx: '99', method: 'onArrival',
        paramsJson: '["x"]', gasLimit: '50000', cb: 'onResult',
        cbParams: '["ctx"]', deadline: '200', hops: '1',
        ...overrides,
    };
    return ['0', callId, p.targetChain, p.targetIdx, p.method, p.paramsJson,
            p.gasLimit, p.cb, p.cbParams, p.deadline, p.hops];
}

const goodCallId = (data) =>
    deriveCallId('regtest', 'BTC', data['TX_HASH'], data['ROOT_ACTION_INDEX'],
                 data['EMITTER'], data['EMITTER_PATH'], data['EMITTER_POSITION'], 'DOGE');

// The block the mirrored result is processed in, 100s after the result's effective_time.
const ctx = () => ({ BLOCK_INDEX: 200, BLOCK_TIME: 1700000100 });

module.exports = {
    PUBKEY_A, SIG_A, deriveCallId, addXcallDbStubs, makeRequestRow, makeResultRow,
    freshXcall, v0Data, v0Params, goodCallId, ctx,
};

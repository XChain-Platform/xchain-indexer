// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Part of test/unit/rollcall_gates_filter.test.js: the two call sites of the
// rules-aware attestation capability filter, the v0 admission reason literal in
// actions/attest.js and the getcapabilityvalidators RPC in api.js. The filter
// itself, and its arming, stay in the entry file.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);

// ---------------------------------------------------------------------------
// The v0 admission reason literal. The gate at actions/attest.js
// must fire the rules-aware literal whenever the filter dropped somebody, and the
// generic one otherwise. Driven through the REAL handler with the module-instance
// stub convention actions/attest.test.js uses; that suite is a separate file,
// so the new literal is pinned here.
// ---------------------------------------------------------------------------

const { createMockIndexer, createBaseData } = require('../../../fixtures/mocks');
const Attest          = require('../../../../src/actions/attest/index.js');
const swq             = require('../../../../src/stake_weighted_quorum.js');
const { stubActiveAt } = require('../../../helpers/gate_modules.js');
const attestBcastFee  = require('../../../../src/actions/attest/attest_broadcast_fee_gate.js');
const arm             = require('../../../../src/attest_response_mirror_activation.js');
// The SAME module object actions/attest.js closed over at require time, which is
// what makes a sinon stub here reach inside the handler.
const rgf             = require('../../../../src/actions/attest/rollcall_gates_filter.js');

const deriveReqId = (txHash, rootActionIndex, emitterPath, contractIndex, position) =>
    crypto.createHash('sha256')
        .update(String(txHash) + ':' + String(rootActionIndex) + ':' + String(emitterPath) + ':' + String(contractIndex) + ':' + String(position))
        .digest('hex');

let indexer, handler;

const KEYS = [PK_A, PK_B, PK_C];

function v0Data(){
    return createBaseData({
        ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, EMITTER: 5, EMITTER_POSITION: 0,
        EMITTER_PATH: '0', ROOT_ACTION_INDEX: 100, BLOCK_INDEX: 100,
    });
}
function v0Params(reqId, redundancy){
    return ['0', reqId, 'http_get', 'q', 'onResult', '[]', String(redundancy), '50'];
}
function reqIdFor(data){
    return deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
}

describe('ATTEST v0 admission: the rules-aware REDUNDANCY literal @regression @tier2', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        const db = indexer.indexerDb;
        db.getContract                     = sinon.stub().resolves({ contract_index: 5 });
        db.createAttestationRequest        = sinon.stub().resolves();
        db.getAttestationAdmissionCounts   = sinon.stub().resolves({ total: 0, byContract: 0 });
        db.getAttestationRequestById       = sinon.stub().resolves(null);
        db.hasCapability                   = sinon.stub().resolves(true);
        db.getValidatorsByCapability       = sinon.stub().resolves(KEYS.map(k => ({ pubkey: k })));
        db.getStakeWeightsByCapability     = sinon.stub().resolves([]);

        handler = new Attest({
            config: indexer.config, util: indexer.util, mapper: indexer.mapper,
            decoderDb: indexer.decoderDb, indexerDb: db,
            actionExecute: { parse: sinon.stub().resolves() },
            protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
        });
        indexer.util.resetLists();
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        sinon.stub(attestBcastFee, 'isAttestBroadcastFeeActive').returns(false);
        sinon.stub(arm, 'isResponseMirrorActive').returns(false);
        // The gate this row's literal lives behind.
        stubActiveAt(sinon, 'attest_admission_activation.ATTEST_ADMISSION_ACTIVATION', true);
    });

    afterEach(function () { sinon.restore(); });

    it('fires the RULES-AWARE literal when the filter dropped a key', async function () {
        sinon.stub(rgf, 'filterByRolledGates').callsFake(async ({ validators, stats }) => {
            // What the real filter fills in; the admission site reads `dropped` and
            // logs the rest, so the stub supplies the whole shape.
            if(stats) Object.assign(stats, { dropped: 2, epochHeight: 960, closeBlock: 990, needed: 4 });
            return validators.slice(0, 1);           // 3 capable keys, 1 rules-current
        });
        const data = v0Data();
        await handler.parse(v0Params(reqIdFor(data), 3), data, null);
        assert.strictEqual(data['STATUS'],
            'invalid: REDUNDANCY (rules-aware set 1 < 3 at request block)',
            'the rules-aware literal must win whenever the filter dropped anybody');
        assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
    });

    it('fires the GENERIC literal when the set was simply too small', async function () {
        // Same shortfall, nothing dropped: a staking problem, not a fleet-roll problem,
        // and the operator must be able to tell them apart from the status alone.
        sinon.stub(rgf, 'filterByRolledGates').callsFake(async ({ validators, stats }) => {
            if(stats) stats.dropped = 0;
            return validators;
        });
        indexer.indexerDb.getValidatorsByCapability.resolves([{ pubkey: PK_A }]);
        const data = v0Data();
        await handler.parse(v0Params(reqIdFor(data), 3), data, null);
        assert.strictEqual(data['STATUS'],
            'invalid: REDUNDANCY (responsible set 1 < 3 at request block)');
    });
});

describe('ATTEST v0 admission: the rules-aware REDUNDANCY literal @regression @tier2', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        const db = indexer.indexerDb;
        db.getContract                     = sinon.stub().resolves({ contract_index: 5 });
        db.createAttestationRequest        = sinon.stub().resolves();
        db.getAttestationAdmissionCounts   = sinon.stub().resolves({ total: 0, byContract: 0 });
        db.getAttestationRequestById       = sinon.stub().resolves(null);
        db.hasCapability                   = sinon.stub().resolves(true);
        db.getValidatorsByCapability       = sinon.stub().resolves(KEYS.map(k => ({ pubkey: k })));
        db.getStakeWeightsByCapability     = sinon.stub().resolves([]);

        handler = new Attest({
            config: indexer.config, util: indexer.util, mapper: indexer.mapper,
            decoderDb: indexer.decoderDb, indexerDb: db,
            actionExecute: { parse: sinon.stub().resolves() },
            protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
        });
        indexer.util.resetLists();
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        sinon.stub(attestBcastFee, 'isAttestBroadcastFeeActive').returns(false);
        sinon.stub(arm, 'isResponseMirrorActive').returns(false);
        // The gate this row's literal lives behind.
        stubActiveAt(sinon, 'attest_admission_activation.ATTEST_ADMISSION_ACTIVATION', true);
    });

    afterEach(function () { sinon.restore(); });

    it('a filter that dropped somebody but left the set servable does NOT reject', async function () {
        // Four capable keys, one dropped by the rules filter, redundancy 3: still
        // servable, so nothing about admission moves and the pinned set is the
        // filtered one. (The mock provider registry allows redundancy 1 and 3, not 2.)
        const PK_D = 'd'.repeat(64);
        indexer.indexerDb.getValidatorsByCapability.resolves(KEYS.concat([PK_D]).map(k => ({ pubkey: k })));
        sinon.stub(rgf, 'filterByRolledGates').callsFake(async ({ validators, stats }) => {
            if(stats) stats.dropped = 1;
            return validators.slice(0, 3);
        });
        const data = v0Data();
        await handler.parse(v0Params(reqIdFor(data), 3), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['REQUEST_STATUS'], 'pending');
        const pinned = JSON.parse(data['RESPONSIBLE_SET_JSON']);
        assert.strictEqual(pinned.length, 3,
            'the pinned set is the FILTERED set, and admission reuses that one computation');
        assert.strictEqual(pinned.indexOf(PK_D), -1, 'the key the filter removed cannot be pinned');
    });
});

describe('ATTEST v0 admission: the rules-aware REDUNDANCY literal @regression @tier2', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        const db = indexer.indexerDb;
        db.getContract                     = sinon.stub().resolves({ contract_index: 5 });
        db.createAttestationRequest        = sinon.stub().resolves();
        db.getAttestationAdmissionCounts   = sinon.stub().resolves({ total: 0, byContract: 0 });
        db.getAttestationRequestById       = sinon.stub().resolves(null);
        db.hasCapability                   = sinon.stub().resolves(true);
        db.getValidatorsByCapability       = sinon.stub().resolves(KEYS.map(k => ({ pubkey: k })));
        db.getStakeWeightsByCapability     = sinon.stub().resolves([]);

        handler = new Attest({
            config: indexer.config, util: indexer.util, mapper: indexer.mapper,
            decoderDb: indexer.decoderDb, indexerDb: db,
            actionExecute: { parse: sinon.stub().resolves() },
            protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
        });
        indexer.util.resetLists();
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        sinon.stub(attestBcastFee, 'isAttestBroadcastFeeActive').returns(false);
        sinon.stub(arm, 'isResponseMirrorActive').returns(false);
        // The gate this row's literal lives behind.
        stubActiveAt(sinon, 'attest_admission_activation.ATTEST_ADMISSION_ACTIVATION', true);
    });

    afterEach(function () { sinon.restore(); });

    it('the filter is applied on the capability snapshot at the request block, once', async function () {
        const spy = sinon.stub(rgf, 'filterByRolledGates').callsFake(async ({ validators }) => validators);
        const data = v0Data();
        await handler.parse(v0Params(reqIdFor(data), 1), data, null);
        assert.strictEqual(spy.callCount, 1, 'admission and the pinned set must share ONE filtered computation');
        const arg = spy.firstCall.args[0];
        assert.strictEqual(arg.requestBlock, 100, 'the filter judges at the request block, not the buried one');
        assert.strictEqual(arg.network, indexer.config['NETWORK']);
        assert.deepStrictEqual(arg.validators.map(v => v.pubkey), KEYS,
            'the RAW capability rows are what is filtered, before any ranking');
    });
});

// ---------------------------------------------------------------------------
// api.js getcapabilityvalidators wiring. startApi() runs at module load and opens
// DB connections, so api.js is not importable under mocha; this is the same
// static source-scan db_rollcalls_public_reads.test.js uses for that layer. The
// arithmetic it asserts about is driven for real in the burial block of
// test/unit/rollcall_gates_filter.test.js.
// ---------------------------------------------------------------------------

describe('api.js getcapabilityvalidators rules filter (source-scan) @regression @tier1', function () {
    const API_SRC = require('../../../helpers/api_source').readApiSource();

    // Just the handler body, so a match cannot come from some other method.
    function handlerBody(){
        const start = API_SRC.indexOf('async getcapabilityvalidators(');
        assert.ok(start > 0, 'getcapabilityvalidators handler not found in src/api.js');
        const next = API_SRC.indexOf('async getfullnodeverifiers(', start);
        assert.ok(next > start, 'could not bound the handler body');
        return API_SRC.slice(start, next);
    }

    it('filters ONLY the attestation capability', function () {
        const body = handlerBody();
        assert.ok(/capability === 'attestation'/.test(body),
            'the filter must be guarded on the attestation capability (D16); price and the ' +
            'other capabilities are untouched by the rules rail');
        const guard = body.indexOf("capability === 'attestation'");
        const call  = body.indexOf('gatesFilter.filterByRolledGates');
        assert.ok(call > guard && call !== -1, 'the filter call must sit INSIDE the attestation guard');
    });

    it('reconstructs the raw request height as block_index + CANONICAL_REORG_BUFFER', function () {
        assert.ok(/requestBlock:\s*blk \+ srb\.CANONICAL_REORG_BUFFER/.test(handlerBody()),
            'the hub buries before it calls, so the RPC must add the buffer back (D86)');
    });

    it('captures `truncated` BEFORE filtering, so the VALIDATOR_QUERY_LIMIT flag survives', function () {
        const body = handlerBody();
        const cap  = body.indexOf('validators.truncated === true');
        const call = body.indexOf('gatesFilter.filterByRolledGates');
        assert.ok(cap !== -1 && call !== -1 && cap < call,
            'the filter returns a fresh array; reading truncated off it afterwards would ' +
            'silently report a truncated snapshot as complete');
        assert.ok(/truncated:\s*truncated,/.test(body), 'the response must echo the captured flag');
    });

    it('keeps the echo fields and the response shape', function () {
        const body = handlerBody();
        for(const field of ['capability:', 'block_index:', 'count:', 'truncated:', 'validators:'])
            assert.ok(body.indexOf(field) !== -1, 'response field missing: ' + field);
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// test/unit/rollcallGatesFilter.test.js
//
// The rules-aware attestation capability filter (attest-zero-confirmation-flip
// spec §7.4, D59-D62, D86, D92) and the two call sites this row wires it into:
// the v0 admission reason literal in actions/attest.js and the
// getcapabilityvalidators RPC's height reconstruction in api.js.
//
// ARMING. ROLLCALL_GATES_ACTIVATION resolves XC_ROLLCALL_GATES_REGTEST_ACTIVATION
// exactly ONCE, at require time, and mocha runs every suite in one process, so a
// file that loaded the inert copy first would pin it for us. The armed copy is
// therefore built in a busted require cache in `before` and the cache is put back
// to its inert shape in `after`, so nothing about this file's arming leaks
// sideways into another suite.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const FILTER_PATH = require.resolve('../../src/rollcall_gates_filter.js');
const ACTIV_PATH  = require.resolve('../../src/rollcall_gates_activation.js');
const ENV_KEY     = 'XC_ROLLCALL_GATES_REGTEST_ACTIVATION';

// The digest and burial seams are deliberately NOT busted: the armed filter must
// share the very instances used here, or `needed` in a test would not be the
// `needed` the filter compared against.
const { activeGatesAt } = require('../../src/consensus_rules_digest.js');
const srb = require('../../src/snapshot_reorg_buffer.js');

function reload(envValue){
    if(envValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = envValue;
    delete require.cache[FILTER_PATH];
    delete require.cache[ACTIV_PATH];
    return require(FILTER_PATH);
}

// A db double that records every getRollcallGatesForFilter call and answers with
// whatever the test set. Nothing else on it is reachable from the filter.
function dbDouble(answer){
    const calls = [];
    return {
        calls,
        getRollcallGatesForFilter: async (atOrBelowBlock, minEpochHeight) => {
            calls.push({ atOrBelowBlock, minEpochHeight });
            return (typeof answer === 'function') ? answer(calls.length) : answer;
        }
    };
}

function epochRow(epochHeight, closeBlock, pairs){
    return {
        epoch_height: epochHeight,
        close_block:  closeBlock,
        gates:        new Map(pairs.map(([k, v]) => [String(k).toLowerCase(), v]))
    };
}

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);

describe('rollcall_gates_filter: the rules-aware attestation capability filter @regression @tier1', function () {

    // H is a regtest height well above the arming height and above the reorg buffer,
    // so the burial arithmetic is the ordinary case rather than the clamp.
    const H = 1000;
    let armed, ENV_BEFORE, NEEDED;

    before(function () {
        ENV_BEFORE = process.env[ENV_KEY];
        armed = reload('armed');
        NEEDED = activeGatesAt(H, 'regtest');
        // Guard the whole file: with no gate active at H every subset test is
        // vacuously true and every "drops" assertion below would pass for the wrong
        // reason. regtest arms most of the canon at genesis, so this must hold.
        assert.ok(NEEDED.length > 0,
            'regtest must have at least one gate active at ' + H + ' or this suite proves nothing');
    });

    after(function () {
        // Put the process-wide cache back to the shape every other suite expects.
        reload(ENV_BEFORE);
    });

    it('is armed for this suite: ROLLCALL_GATES_ACTIVATION.regtest is a finite height', function () {
        const { ROLLCALL_GATES_ACTIVATION } = require(ACTIV_PATH);
        assert.ok(Number.isFinite(ROLLCALL_GATES_ACTIVATION.regtest),
            'the armed reload did not take; every drop assertion below would be a no-op');
    });

    describe('the subset rule', function () {

        it('keeps a validator whose rolled list is exactly the active set', async function () {
            const db  = dbDouble(epochRow(960, 990, [[PK_A, NEEDED.slice()]]));
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out.map(v => v.pubkey), [PK_A]);
        });

        it('keeps a validator whose rolled list is a strict SUPERSET of the active set', async function () {
            // The whole point of D48: a build that knows gates armed after the epoch
            // closed is still a build that knows every gate governing this request.
            const db  = dbDouble(epochRow(960, 990, [[PK_A, NEEDED.concat(['future_module.FUTURE_GATE'])]]));
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out.map(v => v.pubkey), [PK_A]);
        });

        it('DROPS a validator missing exactly one active gate', async function () {
            const missingOne = NEEDED.slice(1);
            const db  = dbDouble(epochRow(960, 990, [[PK_A, missingOne]]));
            const stats = {};
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest', stats });
            assert.deepStrictEqual(out, [], 'a list short one active gate must not survive');
            assert.strictEqual(stats.dropped, 1);
            assert.strictEqual(stats.epochHeight, 960);
            assert.strictEqual(stats.closeBlock, 990);
            assert.strictEqual(stats.needed, NEEDED.length);
        });

        it('keeps a validator with NO row in the rolled epoch', async function () {
            // Never-rolled and not-yet-rolled are the liveness-eviction rail's problem,
            // so the bootstrap epoch right after arming filters nobody (spec §7.4).
            const db  = dbDouble(epochRow(960, 990, [[PK_A, NEEDED.slice()]]));
            const stats = {};
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_B }, { pubkey: PK_C }], requestBlock: H, network: 'regtest', stats });
            assert.deepStrictEqual(out.map(v => v.pubkey), [PK_B, PK_C]);
            assert.strictEqual(stats.dropped, 0);
        });

        it('an EMPTY recorded list is "knows no gate" and is dropped', async function () {
            // db.getRollcallGatesForFilter maps a malformed gates_json to [], and that
            // must read as a drop, never as a pass: a row that exists and names nothing
            // is a positive statement, unlike an absent row.
            const db  = dbDouble(epochRow(960, 990, [[PK_A, []]]));
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out, []);
        });

        it('matches the pubkey case-insensitively (rows are stored lower-cased)', async function () {
            const db  = dbDouble(epochRow(960, 990, [[PK_A, NEEDED.slice(1)]]));
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A.toUpperCase() }], requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out, [], 'an upper-cased key must still find its row');
        });

        it('preserves input ORDER and the full row objects of the survivors', async function () {
            const db = dbDouble(epochRow(960, 990, [
                [PK_A, NEEDED.slice()],
                [PK_B, NEEDED.slice(1)],       // dropped
                [PK_C, NEEDED.slice()],
            ]));
            const rows = [
                { pubkey: PK_C, source: 'S3', weight: '30' },
                { pubkey: PK_B, source: 'S2', weight: '20' },
                { pubkey: PK_A, source: 'S1', weight: '10' },
            ];
            const out = await armed.filterByRolledGates({
                db, validators: rows, requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out.map(v => v.pubkey), [PK_C, PK_A], 'order must be the input order');
            assert.deepStrictEqual(out[0], { pubkey: PK_C, source: 'S3', weight: '30' },
                'the whole capability row must survive, weight and source included');
        });
    });

    describe('the documented cost (spec §7.5): a gate armed after the epoch drops the fleet', function () {

        it('every validator with a row is dropped when a newly armed gate is in none of them', async function () {
            // This is the cost the spec states plainly and this row must not paper over:
            // a new gate cannot arm before every validator that should serve has rolled a
            // call naming it, so arming lags the fleet roll by one epoch close. Here the
            // rolled epoch predates the arming, every list is the active set MINUS the new
            // gate, and the whole rolled fleet goes.
            const beforeArming = NEEDED.slice(0, NEEDED.length - 1);
            const db = dbDouble(epochRow(960, 990, [
                [PK_A, beforeArming], [PK_B, beforeArming], [PK_C, beforeArming],
            ]));
            const stats = {};
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }, { pubkey: PK_B }, { pubkey: PK_C }],
                requestBlock: H, network: 'regtest', stats });
            assert.deepStrictEqual(out, [], 'the spec §7.5 cost: the whole rolled fleet is dropped');
            assert.strictEqual(stats.dropped, 3);
            // And the operator gets exactly one line naming the count and the epoch.
            const line = armed.formatGatesFilterStats(stats);
            assert.ok(/dropped 3 validator\(s\)/.test(line), 'one summary line, got: ' + line);
            assert.ok(line.indexOf('960') !== -1 && line.indexOf('990') !== -1,
                'the line must name the epoch and its close block, got: ' + line);
        });

        it('formatGatesFilterStats says nothing when nothing was dropped', function () {
            assert.strictEqual(armed.formatGatesFilterStats({ dropped: 0, epochHeight: 960 }), null);
            assert.strictEqual(armed.formatGatesFilterStats(null), null);
        });
    });

    describe('the pass-through cases', function () {

        it('an INERT network never reads the database and returns the same array reference', async function () {
            // mainnet and testnet ship ROLLCALL_GATES_ACTIVATION null, and an un-armed
            // network must be byte-for-byte the pre-filter indexer INCLUDING its query
            // count; the admission suite asserts one snapshot query per request.
            const db   = dbDouble(epochRow(960, 990, [[PK_A, []]]));
            const rows = [{ pubkey: PK_A }];
            for(const net of ['mainnet', 'testnet']){
                const out = await armed.filterByRolledGates({
                    db, validators: rows, requestBlock: H, network: net });
                assert.strictEqual(out, rows, net + ': the input array itself must come back');
            }
            assert.strictEqual(db.calls.length, 0, 'an inert network must issue NO query');
        });

        it('an unknown network is inert too', async function () {
            const db   = dbDouble(epochRow(960, 990, [[PK_A, []]]));
            const rows = [{ pubkey: PK_A }];
            const out  = await armed.filterByRolledGates({
                db, validators: rows, requestBlock: H, network: 'nosuchnet' });
            assert.strictEqual(out, rows);
            assert.strictEqual(db.calls.length, 0);
        });

        it('a null epoch (no rolled epoch closed at or below the buried block) keeps everyone', async function () {
            const db  = dbDouble(null);
            const rows = [{ pubkey: PK_A }, { pubkey: PK_B }];
            const out = await armed.filterByRolledGates({
                db, validators: rows, requestBlock: H, network: 'regtest' });
            assert.strictEqual(out, rows, 'the input reference survives so array side-properties do');
            assert.strictEqual(db.calls.length, 1, 'an armed network DOES ask');
        });

        it('an empty validator list short-circuits without a query', async function () {
            const db  = dbDouble(epochRow(960, 990, [[PK_A, []]]));
            const out = await armed.filterByRolledGates({
                db, validators: [], requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out, []);
            assert.strictEqual(db.calls.length, 0);
        });

        it('a db without the read helper is a pass-through, not a throw', async function () {
            const rows = [{ pubkey: PK_A }];
            const out  = await armed.filterByRolledGates({
                db: {}, validators: rows, requestBlock: H, network: 'regtest' });
            assert.strictEqual(out, rows);
        });
    });

    describe('determinism and the burial plane', function () {

        it('reads the epoch at the SAME burial the capability snapshot resolves at', async function () {
            const db = dbDouble(null);
            await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest' });
            assert.strictEqual(db.calls[0].atOrBelowBlock, srb.buriedSnapshotBlock(H, 'regtest'),
                'the filter must bury the request block exactly as _computeResponsibleSet does');
            assert.strictEqual(db.calls[0].atOrBelowBlock, H - srb.CANONICAL_REORG_BUFFER,
                'regtest arms burial at genesis, so the buried block is H - 6');
        });

        it('asks only for epochs at or above the arming height', async function () {
            const { ROLLCALL_GATES_ACTIVATION } = require(ACTIV_PATH);
            const db = dbDouble(null);
            await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest' });
            assert.strictEqual(db.calls[0].minEpochHeight, ROLLCALL_GATES_ACTIVATION.regtest);
        });

        it('is pure: the same inputs give the same answer and the input array is not mutated', async function () {
            const rows = [{ pubkey: PK_A }, { pubkey: PK_B }];
            const mk   = () => dbDouble(epochRow(960, 990, [[PK_A, NEEDED.slice(1)], [PK_B, NEEDED.slice()]]));
            const one  = await armed.filterByRolledGates({ db: mk(), validators: rows, requestBlock: H, network: 'regtest' });
            const two  = await armed.filterByRolledGates({ db: mk(), validators: rows, requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(one.map(v => v.pubkey), [PK_B]);
            assert.deepStrictEqual(two.map(v => v.pubkey), [PK_B]);
            assert.deepStrictEqual(rows.map(v => v.pubkey), [PK_A, PK_B], 'the caller\'s array must be untouched');
        });

        it('the RPC height reconstruction round-trips: block_index + buffer buries back to block_index', async function () {
            // What api.js getcapabilityvalidators relies on. The hub buries BEFORE it
            // calls, so the RPC's block_index is already buried; the filter buries its
            // own argument, so the RPC must hand it the raw height whose burial is that
            // block_index. If this arithmetic ever stops round-tripping, the hub and the
            // indexer judge the same request at two different heights.
            const buriedFromHub = 994;
            const db = dbDouble(null);
            await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }],
                requestBlock: buriedFromHub + srb.CANONICAL_REORG_BUFFER, network: 'regtest' });
            assert.strictEqual(db.calls[0].atOrBelowBlock, buriedFromHub,
                'the reconstructed height must bury back to exactly the block_index the hub sent');
        });
    });
});

// ---------------------------------------------------------------------------
// The v0 admission reason literal (spec §7.4, D61). The gate at actions/attest.js
// must fire the rules-aware literal whenever the filter dropped somebody, and the
// generic one otherwise. Driven through the REAL handler with the module-instance
// stub convention actions/attest.test.js uses; that suite is another row's surface,
// so the new literal is pinned here.
// ---------------------------------------------------------------------------

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const Attest          = require('../../src/actions/attest.js');
const swq             = require('../../src/stake_weighted_quorum.js');
const attestAdmission = require('../../src/attest_admission_activation.js');
const attestBcastFee  = require('../../src/attest_broadcast_fee_activation.js');
const arm             = require('../../src/attest_response_mirror_activation.js');
// The SAME module object actions/attest.js closed over at require time, which is
// what makes a sinon stub here reach inside the handler.
const rgf             = require('../../src/rollcall_gates_filter.js');

const deriveReqId = (txHash, rootActionIndex, emitterPath, contractIndex, position) =>
    crypto.createHash('sha256')
        .update(String(txHash) + ':' + String(rootActionIndex) + ':' + String(emitterPath) + ':' + String(contractIndex) + ':' + String(position))
        .digest('hex');

describe('ATTEST v0 admission: the rules-aware REDUNDANCY literal @regression @tier2', function () {
    let indexer, handler;

    const KEYS = [PK_A, PK_B, PK_C];

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
        sinon.stub(attestAdmission, 'isAttestAdmissionActive').returns(true);
    });

    afterEach(function () { sinon.restore(); });

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
// static source-scan db.rollcalls-public-reads.test.js uses for that layer. The
// arithmetic it asserts about is driven for real in the burial block above.
// ---------------------------------------------------------------------------

describe('api.js getcapabilityvalidators rules filter (source-scan) @regression @tier1', function () {
    const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

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

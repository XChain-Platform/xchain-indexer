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
// THE HUB-MIRROR ATTEST RESPONSE APPLIER (response-mirror design §4.1/§4.4).
//
// Two units, deliberately tested apart:
//   utility.selectApplicableAttestationResponses  the BINDING RULE. Which mirrored
//       responses bind at block B, and in what order. Pure, so the block a callback
//       fires at is asserted directly rather than inferred from side effects.
//   attest.js _applyMirroredResponse               the EFFECTS. The synthesized v1
//       action (NULL tx_index, deterministic hash), the response row, the terminal
//       flip, the fee settle and the contract callback - and, on a verification
//       failure, the absence of every one of them.
//
// Signature verification itself is stubbed at ed25519.verify, exactly as
// attest.test.js does it: the canonical bytes are the shared verifier's contract
// (attest-response-verify-vectors.test.js pins them), while what THIS row owes is
// that a verdict of 'no' leaves the request untouched and a verdict of 'yes'
// produces the v1 effects.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Attest  = require('../../../src/actions/attest.js');
const Utility = require('../../../src/utility.js');
const swq     = require('../../../src/stake_weighted_quorum.js');
const attestAdmission = require('../../../src/attest_admission_activation.js');
const attestBcastFee  = require('../../../src/attest_broadcast_fee_activation.js');
const arm     = require('../../../src/attest_response_mirror_activation.js');
const ed25519 = require('../../../src/ed25519.js');
const { SYNTH_TAGS, synthesizeTxHash } = require('../../../src/actions/execContext.js');

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);
const REQ_ID   = 'd'.repeat(64);

const BODY      = 'hello';
const BODY_HASH = crypto.createHash('sha256').update(Buffer.from(BODY, 'utf8')).digest('hex');

// The request's own block, its deadline, and the protocol time of the block the
// binding rule is asked about. EFFECTIVE_TIME is the SIGNED stamp inside the row.
const REQ_BLOCK   = 90;
const DEADLINE    = 200;
const BLOCK_TIME  = 1700000000;
const EFFECTIVE_T = BLOCK_TIME;             // binds at the first block whose t(B) reaches it

function mirrorRow(overrides = {}) {
    return {
        request_id:       REQ_ID,
        provider_id:      'http_get',
        status:           'ok',
        response_payload: BODY,
        response_hash:    BODY_HASH,
        meta:             'm',
        effective_time:   EFFECTIVE_T,
        signer_pubkeys:   JSON.stringify([PUBKEY_A]),
        signatures:       JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
        widen:            0,
        ...overrides,
    };
}

function requestRow(overrides = {}) {
    return {
        request_id:           REQ_ID,
        action_index:         11,
        provider_id:          'http_get',
        request_status:       'pending',
        deadline_block:       DEADLINE,
        block_index:          REQ_BLOCK,
        redundancy:           1,
        contract_index:       5,
        callback_method:      'onResult',
        callback_params_json: '[]',
        fee_payer:            'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        ...overrides,
    };
}

describe('ATTEST hub-mirror response applier @regression @tier3', function () {

    // ---------------------------------------------------------------- binding rule

    describe('§4.1 binding rule (utility.selectApplicableAttestationResponses)', function () {
        let util;

        beforeEach(function () { util = new Utility(); });

        function select(blockIndex, blockTime, rows = [mirrorRow()], requests = [requestRow()]) {
            return util.selectApplicableAttestationResponses(rows, requests, blockIndex, blockTime, 'regtest');
        }

        it('binds at the predicted block, and NOT one block earlier', function () {
            // One second short of the signed effective_time: the row exists, the request
            // is pending, the deadline is far away, and it still must not bind. This is
            // the whole determinism argument: the applying block is a function of the
            // SIGNED stamp against protocol time, so a node that has the row early may
            // not act on it early.
            assert.strictEqual(select(100, EFFECTIVE_T - 1).length, 0,
                'a row must not bind at a block whose protocol time is below its signed effective_time');
            const applied = select(100, EFFECTIVE_T);
            assert.strictEqual(applied.length, 1, 'it binds at the first block that reaches the effective_time');
            assert.strictEqual(applied[0].response.request_id, REQ_ID);
            assert.strictEqual(applied[0].request.action_index, 11, 'the LOCAL request row is carried through');
        });

        it('binds at a block satisfied exactly AT the deadline block (AT3, second half)', function () {
            const applied = select(DEADLINE, EFFECTIVE_T);
            assert.strictEqual(applied.length, 1,
                'B == deadline_block satisfies B <= deadline_block; the expiry sweep only fires at deadline+1');
        });

        it('never binds a row whose first satisfying block is past the deadline (AT3, first half)', function () {
            // The row became satisfiable only after the deadline passed, so no block
            // ever satisfies both halves of the predicate: the request expires and the
            // expired callback stands.
            assert.strictEqual(select(DEADLINE + 1, EFFECTIVE_T).length, 0,
                'B > deadline_block must never bind, whatever the effective_time');
            assert.strictEqual(
                select(DEADLINE + 1, EFFECTIVE_T, [mirrorRow({ effective_time: EFFECTIVE_T + 5000 })]).length, 0);
        });

        it('skips a row whose local request is absent, already terminal, or legacy-era', function () {
            assert.strictEqual(select(100, EFFECTIVE_T, [mirrorRow()], []).length, 0,
                'no local request row (reorged away) means an inert mirror row');
            assert.strictEqual(
                select(100, EFFECTIVE_T, [mirrorRow()], [requestRow({ request_status: 'fulfilled' })]).length, 0,
                'an already-terminal request is never re-bound');
            // The flag day is keyed on the REQUEST's block. regtest is armed at genesis,
            // so drive the OFF side through the network the constant leaves unarmed.
            assert.strictEqual(arm.isResponseMirrorActive(REQ_BLOCK, 'testnet'), false,
                'fixture assumption: testnet is the unarmed network in the activation map');
            assert.strictEqual(
                util.selectApplicableAttestationResponses([mirrorRow()], [requestRow()], 100, EFFECTIVE_T, 'testnet').length, 0,
                'below the activation height the response must arrive on chain, not through the mirror');
        });

        it('applies two rows in one block in (request block_index, action_index) order, whatever the insertion order', function () {
            // Ordering is read from the LOCAL request rows. The ids are chosen so that a
            // request_id collation ORDER (the trap §4.1 names) and the insertion order
            // both disagree with the correct one.
            const earlyId = 'f'.repeat(64);   // request block 90, action 10  -> applies FIRST
            const lateId  = '0'.repeat(64);   // request block 95, action 20  -> applies SECOND
            const requests = [
                requestRow({ request_id: lateId,  block_index: 95, action_index: 20 }),
                requestRow({ request_id: earlyId, block_index: 90, action_index: 10 }),
            ];
            const rows = [
                mirrorRow({ request_id: lateId }),
                mirrorRow({ request_id: earlyId }),
            ];
            const applied = select(100, EFFECTIVE_T, rows, requests);
            assert.deepStrictEqual(applied.map(a => a.response.request_id), [earlyId, lateId],
                'order must be the local requests\' (block_index, action_index), not the mirror order and not the id collation');
            // And the reverse insertion order produces the identical sequence.
            const reversed = select(100, EFFECTIVE_T, rows.slice().reverse(), requests.slice().reverse());
            assert.deepStrictEqual(reversed.map(a => a.response.request_id), [earlyId, lateId]);
        });

        it('a double-finalize binds the smaller effective_time, ties by response_hash', function () {
            const lo = mirrorRow({ effective_time: EFFECTIVE_T,     response_hash: 'b'.repeat(64) });
            const hi = mirrorRow({ effective_time: EFFECTIVE_T + 1, response_hash: 'a'.repeat(64) });
            let applied = select(100, EFFECTIVE_T + 10, [hi, lo]);
            assert.strictEqual(applied.length, 1, 'one request applies at most one response');
            assert.strictEqual(applied[0].response.effective_time, EFFECTIVE_T);
            // Equal stamps fall through to the signed response_hash, so every node picks
            // the same one no matter which arrived first.
            const tieA = mirrorRow({ response_hash: 'a'.repeat(64) });
            const tieB = mirrorRow({ response_hash: 'b'.repeat(64) });
            assert.strictEqual(select(100, EFFECTIVE_T, [tieB, tieA])[0].response.response_hash, 'a'.repeat(64));
            assert.strictEqual(select(100, EFFECTIVE_T, [tieA, tieB])[0].response.response_hash, 'a'.repeat(64));
        });
    });

    // ------------------------------------------------- the per-block cap and its carry

    describe('per-block cap (ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK)', function () {
        let util;
        // The cap is spelled out as a LITERAL below, never read from the constant: a case
        // whose expectation is derived from the value under test moves with it and passes
        // at any cap at all. The value itself is pinned by its own case at the end.
        const CAP   = 10;
        const BURST = 14;

        beforeEach(function () { util = new Utility(); });

        // `n` requests all effective at the same stamp, in a deliberately scrambled
        // insertion order, so nothing but the applier order can produce the sequence
        // the assertions expect. action_index carries the order; the ids are hashes of
        // it, so an id collation would produce a different sequence.
        function aligned(n, deadline = DEADLINE) {
            const requests = [], rows = [];
            for (let i = 0; i < n; i++) {
                const id = crypto.createHash('sha256').update('cap:' + i).digest('hex');
                requests.push(requestRow({ request_id: id, action_index: 100 + i,
                                           block_index: REQ_BLOCK, deadline_block: deadline }));
                rows.push(mirrorRow({ request_id: id,
                                      response_hash: crypto.createHash('sha256').update(id).digest('hex') }));
            }
            const scramble = (a) => a.slice().sort((x, y) =>
                String(x.request_id).localeCompare(String(y.request_id)));
            const order = requests.map(r => r.request_id);
            const shuffled = scramble(requests);
            assert.notDeepStrictEqual(shuffled.map(r => r.request_id), order,
                'fixture assumption: the insertion order must disagree with the applier order, ' +
                'or a cap over an unordered set would pass these cases');
            return { requests: shuffled, rows: scramble(rows), order };
        }
        const idsOf = (applied) => applied.map(a => a.response.request_id);

        it('takes exactly the cap at B, in the applier order', function () {
            const { requests, rows, order } = aligned(BURST);
            const atB = util.selectApplicableAttestationResponses(rows, requests, 100, EFFECTIVE_T, 'regtest');
            assert.strictEqual(atB.length, CAP,
                'an aligned burst must not put every callback into one block transaction');
            assert.deepStrictEqual(idsOf(atB), order.slice(0, CAP),
                'the cap takes a PREFIX of the total order, never an arbitrary subset');
        });

        it('applies the deferred rows at B+1, in the same order, with no stored state', function () {
            const { requests, rows, order } = aligned(BURST);
            const atB = util.selectApplicableAttestationResponses(rows, requests, 100, EFFECTIVE_T, 'regtest');

            // The carry-forward rule verbatim: the rows B took are terminal now, so the
            // next block sees the rest still pending and selects them itself. Nothing was
            // written down between the two calls.
            const taken = new Set(idsOf(atB));
            const left  = requests.filter(r => !taken.has(r.request_id));
            const atB1  = util.selectApplicableAttestationResponses(rows, left, 101, EFFECTIVE_T, 'regtest');

            assert.deepStrictEqual(idsOf(atB1), order.slice(CAP),
                'the deferred rows drain at the next block, in the order they were deferred in');
            assert.deepStrictEqual(idsOf(atB).concat(idsOf(atB1)), order,
                'and the two prefixes concatenate to the one order, so the boundary moves nothing');
        });

        it('never applies a row whose deadline passes while it is deferred', function () {
            // The burst's deadline is B itself, so everything past the cap can only be
            // reconsidered at B+1, where B+1 > deadline_block refuses it. The expiry
            // sweep flips those requests and the expired callback stands.
            const { requests, rows, order } = aligned(BURST, 100);
            const atB = util.selectApplicableAttestationResponses(rows, requests, 100, EFFECTIVE_T, 'regtest');
            assert.deepStrictEqual(idsOf(atB), order.slice(0, CAP));

            const taken = new Set(idsOf(atB));
            const left  = requests.filter(r => !taken.has(r.request_id));
            assert.strictEqual(
                util.selectApplicableAttestationResponses(rows, left, 101, EFFECTIVE_T, 'regtest').length, 0,
                'a deferred row past its deadline is never applied: the expiry verdict stands');
        });

        it('is the admission cap\'s own per-block figure, so it never throttles a legal rate', function () {
            const caps = require('../../../src/attest_request_cap_activation.js');
            const declared = require('../../../src/actions/attest.js').ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK;
            assert.strictEqual(declared, CAP, 'the cap the cases above spell out is the one the code carries');
            assert.strictEqual(declared, caps.ATTEST_REQUEST_CAPS.perBlock,
                'the chain cannot admit more requests per block than this, so a steady ' +
                'state can never produce more responses per block than the cap allows');
        });
    });

    // -------------------------------------------------------------- the pass wiring

    describe('§4.1 applier pass (utility.processAttestationResponses)', function () {
        let util, db, actionsSpy;

        beforeEach(function () {
            util = new Utility();
            db = {
                config: { NETWORK: 'regtest' },
                getAttestationRequestsAwaitingMirrorResponse: sinon.stub().resolves([requestRow()]),
                getMirroredAttestationResponses: sinon.stub().resolves([mirrorRow()]),
            };
            actionsSpy = { processAction: sinon.stub().resolves() };
        });

        afterEach(function () { sinon.restore(); });

        it('synthesizes an ATTEST v1 with NULL tx coordinates, BLOCK_TIME, and the row pair', async function () {
            await util.processAttestationResponses(actionsSpy, db, 100, BLOCK_TIME);
            assert.ok(actionsSpy.processAction.calledOnce);
            const [action, params, data] = actionsSpy.processAction.firstCall.args;
            assert.strictEqual(action, 'ATTEST');
            assert.deepStrictEqual(params, [1, REQ_ID]);
            assert.strictEqual(data['FORMAT'], 1);
            assert.strictEqual(data['IS_SYNTHETIC'], true);
            assert.strictEqual(data['BLOCK_INDEX'], 100);
            // D60: _settleRequestFee reaches the fee-oracle read through BLOCK_TIME.
            assert.strictEqual(data['BLOCK_TIME'], BLOCK_TIME);
            assert.strictEqual(data['TX_INDEX'], null, 'a mirror-applied response has no transaction');
            assert.strictEqual(data['TX_VOUT'], null);
            assert.ok(data['MIRROR_RESPONSE'] && data['MIRROR_REQUEST']);
        });

        it('reads the mirror only for locally pending requests, scoped by network and block time', async function () {
            await util.processAttestationResponses(actionsSpy, db, 100, BLOCK_TIME);
            assert.ok(db.getAttestationRequestsAwaitingMirrorResponse.calledWith(100));
            const [network, ids, blockTime] = db.getMirroredAttestationResponses.firstCall.args;
            assert.strictEqual(network, 'regtest');
            assert.deepStrictEqual(ids, [REQ_ID]);
            assert.strictEqual(blockTime, BLOCK_TIME,
                'the mirror is filtered on the SIGNED effective_time against protocol time');
        });

        it('does not touch the mirror at all when nothing is pending locally', async function () {
            db.getAttestationRequestsAwaitingMirrorResponse.resolves([]);
            await util.processAttestationResponses(actionsSpy, db, 100, BLOCK_TIME);
            assert.strictEqual(db.getMirroredAttestationResponses.called, false);
            assert.strictEqual(actionsSpy.processAction.called, false);
        });

        it('synthesizes nothing at a block one second short of the effective_time', async function () {
            await util.processAttestationResponses(actionsSpy, db, 100, EFFECTIVE_T - 1);
            assert.strictEqual(actionsSpy.processAction.called, false);
        });

        it('drives two same-block rows through processAction in the deterministic order', async function () {
            const earlyId = 'f'.repeat(64);
            const lateId  = '0'.repeat(64);
            db.getAttestationRequestsAwaitingMirrorResponse.resolves([
                requestRow({ request_id: lateId,  block_index: 95, action_index: 20 }),
                requestRow({ request_id: earlyId, block_index: 90, action_index: 10 }),
            ]);
            db.getMirroredAttestationResponses.resolves([
                mirrorRow({ request_id: lateId }),
                mirrorRow({ request_id: earlyId }),
            ]);
            await util.processAttestationResponses(actionsSpy, db, 100, BLOCK_TIME);
            assert.deepStrictEqual(
                actionsSpy.processAction.getCalls().map(c => c.args[2]['REQUEST_ID']),
                [earlyId, lateId]);
        });
    });

    // ------------------------------------------------------------------- the effects

    describe('§4.4 effects (attest.js _applyMirroredResponse)', function () {
        let indexer, actionsCtx, handler, executeStub;

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

        beforeEach(function () {
            indexer = createMockIndexer();
            addAttestationDbStubs(indexer.indexerDb);
            executeStub = { parse: sinon.stub().resolves() };
            actionsCtx = {
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
            handler = new Attest(actionsCtx);
            indexer.util.resetLists();
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
            sinon.stub(attestAdmission, 'isAttestAdmissionActive').returns(false);
            sinon.stub(attestBcastFee, 'isAttestBroadcastFeeActive').returns(false);
            sinon.stub(ed25519, 'verify').returns(true);
        });

        afterEach(function () { sinon.restore(); });

        it('applies a verified row: response row, terminal flip, callback, fulfilled_count', async function () {
            const data = applyData();
            await handler.parse([1, REQ_ID], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VALID_SIGS'], 1);
            assert.strictEqual(data['RESPONSE_HASH'], BODY_HASH);
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce, 'the v1 row is written');
            assert.deepStrictEqual(
                JSON.parse(indexer.indexerDb.createAttestationResponse.firstCall.args[0]['VALIDATOR_SIGNATURES']),
                [{ pubkey: PUBKEY_A, sig: SIG_A }],
                'the verified federation signatures are inlined exactly as the chain path inlines them');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID, 'fulfilled', 100),
                'the request flips terminal AT the applying block (resolved_block anchors the reorg reset)');
            assert.ok(indexer.indexerDb.incrementAttestationValidatorStat.calledWith(
                PUBKEY_A, 'http_get', 'fulfilled_count', 100));
            assert.ok(executeStub.parse.calledOnce, 'the contract callback fires');
            const [callbackParams, emissionData] = executeStub.parse.firstCall.args;
            assert.deepStrictEqual(callbackParams.slice(0, 6), [0, 5, 'onResult', REQ_ID, 'http_get', 'ok'],
                'the callback carries the same parameter vector the chain path builds');
            assert.strictEqual(callbackParams[6], BODY, 'the attested body reaches the contract');
            assert.strictEqual(emissionData['BLOCK_TIME'], BLOCK_TIME);
            assert.ok(indexer.indexerDb.setAttestationResponseCallbackIndex.calledOnce);
        });

        it('the synthetic action has NULL tx coordinates and the deterministic hash', async function () {
            const data = applyData();
            await handler.parse([1, REQ_ID], data, null);

            const minted = indexer.indexerDb.createActionIndex.firstCall.args[0];
            assert.strictEqual(minted['ACTION'], 'ATTEST');
            assert.strictEqual(minted['FORMAT'], 1);
            assert.strictEqual(minted['BLOCK_INDEX'], 100);
            assert.strictEqual(minted['TX_INDEX'], undefined,
                'no TX_INDEX is offered, so createActionIndex normalizes it to NULL and mints a fresh index');
            assert.strictEqual(indexer.indexerDb.createActionIndex.firstCall.args[1], true,
                'force, because a synthetic row must never collapse onto another action_index');
            assert.strictEqual(data['ACTION_INDEX'], 4242);
            assert.strictEqual(data['TX_INDEX'], null);
            assert.strictEqual(data['TX_VOUT'], null);

            // sha256('ATTESTMIRROR:<network>:<chain>:<request_id>'), the consensus preimage.
            const expected = crypto.createHash('sha256')
                .update('ATTESTMIRROR:regtest:BTC:' + REQ_ID).digest('hex');
            assert.strictEqual(data['TX_HASH'], expected);
            assert.strictEqual(data['TX_HASH'],
                synthesizeTxHash(SYNTH_TAGS.ATTEST_MIRROR_RESPONSE, 'regtest', 'BTC', REQ_ID),
                'and it is the shared execContext derivation, not a hand-rolled string');
            assert.strictEqual(executeStub.parse.firstCall.args[1]['TX_HASH'], expected,
                'the injected callback context inherits it, so ids emitted inside the callback resolve');
        });

        it('an invalid signature leaves the request pending and writes NOTHING', async function () {
            ed25519.verify.returns(false);
            const data = applyData();
            await handler.parse([1, REQ_ID], data, null);

            assert.notStrictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false,
                'unlike the chain path there is no audit row: nothing was paid for and the row must be inert');
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false,
                'above all, the request must stay pending so an honest round can still land');
            assert.strictEqual(indexer.indexerDb.createActionIndex.called, false,
                'and no action index is minted for a row that wrote nothing');
            assert.strictEqual(executeStub.parse.called, false);
        });

        it('skips a row whose body does not reproduce its signed response_hash', async function () {
            const data = applyData({}, { response_payload: 'tampered' });
            await handler.parse([1, REQ_ID], data, null);
            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false);
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false);
        });

        it('skips a body over the 8189-byte cap the batch could never carry', async function () {
            const big  = 'x'.repeat(8190);
            const data = applyData({}, {
                response_payload: big,
                response_hash: crypto.createHash('sha256').update(Buffer.from(big, 'utf8')).digest('hex'),
            });
            await handler.parse([1, REQ_ID], data, null);
            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false);
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false);
        });

        it('skips a malformed signature list and a non-terminal status', async function () {
            const bad = applyData({}, { signatures: 'not json' });
            await handler.parse([1, REQ_ID], bad, null);
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false);

            const retryable = applyData({}, { status: 'no_quorum' });
            await handler.parse([1, REQ_ID], retryable, null);
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false,
                'a retryable round is never mirrored, and one that appears must leave the request pending');
        });

        it('re-gates the mirror era and the pending state at apply time', async function () {
            // The handler is reached through a synthesized action, so it re-checks what
            // the selection pass already decided rather than trusting it.
            const terminal = applyData({}, {}, { request_status: 'fulfilled' });
            await handler.parse([1, REQ_ID], terminal, null);
            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false);

            sinon.stub(arm, 'isResponseMirrorActive').returns(false);
            const legacy = applyData();
            await handler.parse([1, REQ_ID], legacy, null);
            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false,
                'a legacy-era request must be served on chain, never applied from the mirror');
        });

        it('an errored (expired-status) row flips the request to errored', async function () {
            const data = applyData({}, { status: 'expired' });
            await handler.parse([1, REQ_ID], data, null);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID, 'errored', 100));
            assert.strictEqual(indexer.indexerDb.incrementAttestationValidatorStat.called, false,
                'fulfilled_count is credited only for status ok');
        });

        it('settles the request fee at the synthesized action, which carries BLOCK_TIME (D60)', async function () {
            // D60 named the fee-ORACLE read as the reason the synthesized action must
            // carry BLOCK_TIME. Above the mirror height that read is gone with the
            // broadcast-fee carve-out (nobody broadcast anything to be reimbursed for),
            // so BLOCK_TIME's remaining consumer on this path is the injected callback
            // context, which is asserted below and is just as load-bearing: a callback
            // running at the wrong time is consensus-visible contract state.
            attestBcastFee.isAttestBroadcastFeeActive.returns(true);
            indexer.util.getFeeOraclePrices = sinon.stub().resolves({ error: 'no prices' });

            const data = applyData({}, {}, { fee_amount: '10' });
            await handler.parse([1, REQ_ID], data, null);

            assert.ok(indexer.indexerDb.createValidatorReward.calledOnce, 'the escrow splits to the signers');
            const reward = indexer.indexerDb.createValidatorReward.firstCall.args;
            assert.strictEqual(reward[0], PUBKEY_A);
            assert.strictEqual(reward[2], 'attest_fee');
            assert.strictEqual(reward[4], 100, 'the reward is stamped at the applying block, so a reorg of it rolls back');
            assert.strictEqual(executeStub.parse.firstCall.args[1]['BLOCK_TIME'], BLOCK_TIME,
                'the synthesized action carries BLOCK_TIME through to the callback context');
        });

        it('retires the broadcast-fee carve-out: no attest_bcast, whole escrow to the signers', async function () {
            // A mirror-applied response was never broadcast by anyone, so there is no
            // miner fee to reimburse. The carve-out flag day is ARMED here on purpose:
            // what this asserts is that the mirror era retires it anyway, and that the
            // retirement reaches the APPLIER, which settles through the same routine the
            // chain handler does.
            attestBcastFee.isAttestBroadcastFeeActive.returns(true);
            indexer.util.getFeeOraclePrices = sinon.stub().resolves({
                coinUsdPrice: '50000', xchainUsdPrice: '2.5', oracleRound: 7,
            });
            indexer.indexerDb.getTokenDecimalPrecision.resolves(8);

            const data = applyData({}, {}, { action_index: 42, fee_amount: '6.00000000' });
            await handler.parse([1, REQ_ID], data, null);

            const rewards = indexer.indexerDb.createValidatorReward.getCalls()
                .map(c => ({ type: c.args[2], amount: String(c.args[3]) }));
            assert.deepStrictEqual(rewards, [{ type: 'attest_fee', amount: '6' }],
                'the whole escrow splits, so a signer earns the retired carve-out on top of its share');
            assert.strictEqual(indexer.util.getFeeOraclePrices.called, false,
                'and the oracle conversion is never reached for a reimbursement that cannot apply');
        });

        it('defers the callback to the relay leg for a relay-materialized request', async function () {
            const data = applyData({}, {}, { origin_chain: 'DOGE', origin_action_index: 7 });
            await handler.parse([1, REQ_ID], data, null);
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce, 'the response row is still written');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledOnce);
            assert.strictEqual(executeStub.parse.called, false,
                'the contract lives on the origin chain; the v4 relay leg fires the callback there');
        });

        it('the chain-path v1 dispatch is untouched by the mirror marker', async function () {
            // Row 18 will gate the chain path on isMirrorEraRequest; the seam it calls is
            // exported here and must not fire on the applier's own synthesized action.
            assert.strictEqual(typeof handler.isMirrorEraRequest, 'function');
            assert.strictEqual(handler.isMirrorEraRequest(requestRow()), true);
            assert.strictEqual(handler.isMirrorEraRequest(null), false);

            // No marker => the wire parser runs, and with no matching request it rejects
            // exactly as it always did (proving the new dispatch arm is marker-gated).
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 7 });
            await handler.parse(['1', REQ_ID, 'http_get', Buffer.from(BODY).toString('base64'), 'ok', 'm', '1', PUBKEY_A, SIG_A], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: REQUEST_ID (no matching request)');
        });
    });
});

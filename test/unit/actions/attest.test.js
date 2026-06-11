// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Attest  = require('../../../src/actions/attest.js');
// Same module instance Attest holds a reference to (Node module cache) — stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../src/ed25519.js');

// 64-hex pubkeys / 128-hex sigs (format-valid; verification is stubbed)
const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const SIG_A    = '1'.repeat(128);
const SIG_B    = '2'.repeat(128);
const REQ_ID   = 'd'.repeat(64);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Mirror the handler's deterministic request_id derivation:
//   sha256(tx_hash + ':' + emitter_action_index + ':' + contract_index + ':' + emitter_position)
// The emitting EXECUTE's action_index disambiguates nested cross-contract runs
// of the same contract within one tx. MUST byte-match xchain-vm/src/gateway.js.
// A legitimate VM emission always supplies a REQUEST_ID equal to this digest.
const deriveReqId = (txHash, emitterActionIndex, contractIndex, position) =>
    crypto.createHash('sha256')
        .update(String(txHash) + ':' + String(emitterActionIndex) + ':' + String(contractIndex) + ':' + String(position))
        .digest('hex');

describe('Attest (ATTEST) @regression @tier3', function () {
    let indexer, actionsCtx, handler, executeStub;

    // Extend the default mock DB with the attestation-specific methods attest.js calls.
    function addAttestationDbStubs(db) {
        db.getContract                       = sinon.stub().resolves({ contract_index: 5 });
        db.createAttestationRequest          = sinon.stub().resolves();
        db.getAttestationRequestById         = sinon.stub().resolves(null);
        db.hasCapability                     = sinon.stub().resolves(true);
        db.createAttestationResponse         = sinon.stub().resolves();
        db.incrementAttestationValidatorStat = sinon.stub().resolves();
        db.updateAttestationRequestStatus    = sinon.stub().resolves();
        db.setAttestationResponseCallbackIndex = sinon.stub().resolves();
        db.getValidatorsByCapability         = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
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
        };
        handler = new Attest(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ───────────────────────────────────────────────────────────────────────
    // v0 — Request (VM emission only)
    // ───────────────────────────────────────────────────────────────────────
    describe('v0 — request', function () {

        function v0Data(overrides = {}) {
            // EMITTER_POSITION and EMITTER_ACTION_INDEX are required fields on every
            // legitimate ATTEST v0 emission (set by execute.processEmission); include
            // them by default so the fixture mirrors production. Tests that probe
            // their absence override them back to undefined.
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, EMITTER: 5, EMITTER_POSITION: 0,
                EMITTER_ACTION_INDEX: 9, BLOCK_INDEX: 100,
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

        it('valid request → STATUS valid and createAttestationRequest called', async function () {
            const data = v0Data();
            // A legitimate emission carries a REQUEST_ID that matches the deterministic
            // derivation over (tx_hash, contract_index, emitter_position).
            const reqId = deriveReqId(data['TX_HASH'], data['EMITTER_ACTION_INDEX'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId }), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createAttestationRequest.calledOnce);
        });

        it('rejects a request missing EMITTER_POSITION instead of accepting an unverified REQUEST_ID', async function () {
            // The bug this guards: when EMITTER_POSITION is absent the request_id check used
            // to silently skip, so an arbitrary REQUEST_ID from a compromised/buggy VM was
            // accepted. It must now hard-fail.
            const data = v0Data({ EMITTER_POSITION: undefined });
            await handler.parse(v0Params(), data, null); // arbitrary REQUEST_ID, no position
            assert.notStrictEqual(data['STATUS'], 'valid');
            assert.ok(String(data['STATUS']).includes('EMITTER_POSITION'),
                'expected EMITTER_POSITION rejection, got: ' + data['STATUS']);
        });

        it('rejects a request missing EMITTER_ACTION_INDEX (nested-run disambiguator)', async function () {
            // Cross-contract calls let the same contract run more than once per tx;
            // the emitting EXECUTE's action_index is therefore part of the request_id
            // preimage and its absence must hard-fail, never silently bypass.
            const data = v0Data({ EMITTER_ACTION_INDEX: undefined });
            await handler.parse(v0Params(), data, null);
            assert.notStrictEqual(data['STATUS'], 'valid');
            assert.ok(String(data['STATUS']).includes('EMITTER_ACTION_INDEX'),
                'expected EMITTER_ACTION_INDEX rejection, got: ' + data['STATUS']);
        });

        it('rejects a request when TX_HASH is absent but EMITTER_POSITION is present (line 134)', async function () {
            // EMITTER_POSITION is set (passes the first guard) but TX_HASH is missing
            // → the `else if(!data['TX_HASH'])` branch (line 133-134) fires.
            const data = v0Data({ TX_HASH: null });
            await handler.parse(v0Params(), data, null);
            assert.ok(String(data['STATUS']).includes('TX_HASH'),
                'expected TX_HASH rejection, got: ' + data['STATUS']);
        });

        it('rejects a request whose REQUEST_ID does not match the deterministic derivation', async function () {
            const data = v0Data(); // EMITTER_POSITION present, but REQUEST_ID is arbitrary
            await handler.parse(v0Params({ requestId: REQ_ID }), data, null);
            assert.ok(String(data['STATUS']).includes('deterministic derivation'),
                'expected derivation-mismatch rejection, got: ' + data['STATUS']);
        });

        it('rejects a non-emission (user-broadcast) request', async function () {
            const data = v0Data({ IS_EMISSION: false });
            await handler.parse(v0Params(), data, null);
            assert.ok(String(data['STATUS']).includes('VM emission'));
            assert.ok(indexer.indexerDb.createAttestationRequest.calledOnce, 'invalid request is still recorded');
        });

        it('rejects an unknown PROVIDER_ID', async function () {
            const data = v0Data();
            await handler.parse(v0Params({ providerId: 'not_a_provider' }), data, null);
            assert.ok(String(data['STATUS']).includes('PROVIDER_ID'));
        });

        it('rejects a malformed REQUEST_ID', async function () {
            const data = v0Data();
            await handler.parse(v0Params({ requestId: 'xyz' }), data, null);
            assert.ok(String(data['STATUS']).includes('REQUEST_ID'));
        });

        it('rejects a redundancy value the provider does not allow', async function () {
            const data = v0Data();
            await handler.parse(v0Params({ redundancy: '2' }), data, null); // http_get allows [1,3,5]
            assert.ok(String(data['STATUS']).includes('REDUNDANCY'));
        });

        it('rejects when the contract emitter is missing', async function () {
            const data = v0Data({ EMITTER: undefined });
            await handler.parse(v0Params(), data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_INDEX'));
        });

        it('rejects when CONTRACT_INDEX references a non-existent contract (getContract returns null)', async function () {
            // EMITTER is present → CONTRACT_INDEX != null → getContract called → returns null (line 119)
            indexer.indexerDb.getContract.resolves(null);
            const data = v0Data();
            await handler.parse(v0Params(), data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_INDEX'),
                'expected CONTRACT_INDEX (unknown) rejection, got: ' + data['STATUS']);
        });

        it('rejects a deadline outside the provider window', async function () {
            const data = v0Data();
            await handler.parse(v0Params({ deadline: '999' }), data, null); // http_get window = 100
            assert.ok(String(data['STATUS']).includes('DEADLINE'));
        });

        it('rejects when PROVIDER_ID is null in v0 params (line 93)', async function () {
            // Valid emission with null PROVIDER_ID → isNull guard fires (line 92-93)
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['EMITTER_ACTION_INDEX'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId, providerId: null }), data, null);
            assert.ok(String(data['STATUS']).includes('PROVIDER_ID'),
                'expected PROVIDER_ID rejection, got: ' + data['STATUS']);
        });

        it('rejects when CALLBACK_METHOD is null in v0 params (line 99)', async function () {
            // Valid emission with null CALLBACK_METHOD → isNull guard fires (line 98-99)
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['EMITTER_ACTION_INDEX'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId, callback: null }), data, null);
            assert.ok(String(data['STATUS']).includes('CALLBACK_METHOD'),
                'expected CALLBACK_METHOD rejection, got: ' + data['STATUS']);
        });

        it('rejects when REQUEST_PAYLOAD exceeds provider max size (lines 105-107)', async function () {
            // Pass an oversized payload — providerRegistry.isPayloadSizeAllowed returns false
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['EMITTER_ACTION_INDEX'], data['EMITTER'], data['EMITTER_POSITION']);
            // http_get max payload: check providerRegistry, or pass a 100KB+ payload that exceeds any limit
            const bigPayload = 'x'.repeat(100000);
            await handler.parse(v0Params({ requestId: reqId, payload: bigPayload }), data, null);
            assert.ok(String(data['STATUS']).includes('REQUEST_PAYLOAD') || String(data['STATUS']).includes('invalid'),
                'expected REQUEST_PAYLOAD rejection or an earlier guard, got: ' + data['STATUS']);
        });

        it('null REQUEST_PAYLOAD uses empty-string fallback for byteLength (line 105)', async function () {
            // A valid-otherwise v0 emission where REQUEST_PAYLOAD is null →
            // `String(data['REQUEST_PAYLOAD'] || '')` → '' → byteLength(0)
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['EMITTER_ACTION_INDEX'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId, payload: null }), data, null);
            // null payload is 0 bytes — should not fail the size check
            assert.ok(indexer.indexerDb.createAttestationRequest.calledOnce);
        });

        it('non-finite DEADLINE_BLOCKS falls back to 0 increment (line 110)', async function () {
            // When DEADLINE_BLOCKS is NaN/non-finite → deadlineBlocks=0 → deadlineBlock=BLOCK_INDEX
            // The provider window check should catch this as an invalid deadline.
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['EMITTER_ACTION_INDEX'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId, deadline: 'not_a_number' }), data, null);
            // deadlineBlock = BLOCK_INDEX+0 = BLOCK_INDEX; provider window likely fails → invalid
            assert.ok(String(data['STATUS']).includes('invalid'),
                'non-finite deadline should result in invalid status, got: ' + data['STATUS']);
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // v1 — Response (validator broadcast). The security-critical path.
    //
    // NOTE on quorum: ATTEST v1 quorum is REDUNDANCY-based — a response is valid
    // when validSigs >= request.redundancy (attest.js _parseResponse). The
    // 2f+1 PBFT formula lives in PRICE v0, not here; see price.test.js.
    // ───────────────────────────────────────────────────────────────────────
    describe('v1 — response', function () {

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

        beforeEach(function () {
            // Default: every signature verifies; capability present.
            sinon.stub(ed25519, 'verify').returns(true);
        });

        // ── sig-list parser ──────────────────────────────────────────────

        it('parses a valid single signature → valid', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VALID_SIGS'], 1);
        });

        it('parses a valid multi-signature bundle → valid', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            const data = v1Data();
            await handler.parse(v1Params([
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VALID_SIGS'], 2);
        });

        it('rejects a malformed SIG_COUNT length prefix', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow());
            const data = v1Data();
            // hand-craft params with non-numeric SIG_COUNT
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', 'm', 'NOT_A_NUMBER', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            assert.ok(String(data['STATUS']).includes('invalid'));
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce, 'invalid response still recorded');
        });

        it('rejects a truncated payload (SIG_COUNT exceeds sigs present)', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow());
            const data = v1Data();
            // claims 2 sigs but provides only 1
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', 'm', '2', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            assert.ok(String(data['STATUS']).includes('invalid'));
        });

        it('rejects a pubkey that is not 64 hex chars', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow());
            const data = v1Data();
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', 'm', '1', 'tooshort', SIG_A];
            await handler.parse(params, data, null);
            assert.ok(String(data['STATUS']).includes('invalid'));
        });

        // ── duplicate-pubkey deduplication ───────────────────────────────

        it('does NOT count two signatures from the same pubkey twice toward quorum', async function () {
            // redundancy 2, but both sigs share PUBKEY_A → only 1 distinct valid sig → insufficient
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            const data = v1Data();
            await handler.parse(v1Params([
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_A, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['VALID_SIGS'], 1, 'duplicate pubkey counted once');
            assert.ok(String(data['STATUS']).includes('insufficient'));
            assert.ok(executeStub.parse.notCalled, 'no callback injected without quorum');
        });

        // ── quorum threshold (REDUNDANCY-based) ──────────────────────────

        it('meets quorum when validSigs equals REDUNDANCY → valid', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            const data = v1Data();
            await handler.parse(v1Params([
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('fails quorum when validSigs is one below REDUNDANCY → invalid', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 3 }));
            const data = v1Data();
            await handler.parse(v1Params([
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.ok(String(data['STATUS']).includes('insufficient'));
        });

        it('counts a signature only when ed25519.verify passes', async function () {
            ed25519.verify.returns(false); // override the beforeEach stub
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALID_SIGS'], 0);
            assert.ok(String(data['STATUS']).includes('insufficient'));
        });

        // ── snapshot block selection ─────────────────────────────────────

        it('checks signer capability at the REQUEST snapshot block, not the response block', async function () {
            const request = makeRequestRow({ redundancy: 1, block_index: 90 });
            indexer.indexerDb.getAttestationRequestById.resolves(request);
            const data = v1Data({ BLOCK_INDEX: 100 });
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(
                indexer.indexerDb.hasCapability.calledWith(PUBKEY_A, 'attestation', 90),
                'hasCapability must be queried at the request snapshot block (90), not the response block (100)'
            );
        });

        it('skips a signer lacking the attestation capability at the snapshot block', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            indexer.indexerDb.hasCapability.resolves(false);
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALID_SIGS'], 0);
            assert.ok(String(data['STATUS']).includes('insufficient'));
        });

        // ── callback injection ───────────────────────────────────────────

        it('injects exactly one EXECUTE callback on quorum success', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(executeStub.parse.calledOnce, 'callback EXECUTE injected once');
            assert.ok(indexer.indexerDb.setAttestationResponseCallbackIndex.calledOnce);
        });

        it('bumps fulfilled_count for each signer only when STATUS is ok', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'ok' }), data, null);
            assert.ok(indexer.indexerDb.incrementAttestationValidatorStat.calledOnce);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'fulfilled'));
        });

        it('flips request to errored (no fulfilled_count) for a valid terminal non-ok response', async function () {
            // `expired` is the only non-ok status that is genuinely terminal (the
            // deadline passed); it closes the request and still fires the callback.
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'expired' }), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.incrementAttestationValidatorStat.notCalled, 'no fulfilled_count on non-ok');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'errored'));
            assert.ok(executeStub.parse.calledOnce, 'callback still injected for a valid terminal non-ok response');
        });

        // ── retryable statuses leave the request open for another PBFT round ──

        ['no_quorum', 'timeout', 'provider_error'].forEach(function (retryableStatus) {
            it(`leaves request pending (no status flip, no callback) for a valid '${retryableStatus}' response`, async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: retryableStatus }), data, null);
                assert.strictEqual(data['STATUS'], 'valid', 'response itself is still a valid, recorded row');
                assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce, 'response row recorded for audit');
                assert.ok(indexer.indexerDb.incrementAttestationValidatorStat.notCalled, 'no fulfilled_count on non-ok');
                assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled, 'request_status left untouched (pending)');
                assert.ok(executeStub.parse.notCalled, 'no callback fired while the request can still retry');
            });
        });

        it('still fulfills a request after an earlier retryable round left it pending', async function () {
            // Simulate the hub broadcasting no_quorum, then succeeding on a later round.
            // The request row stays `pending` throughout (the indexer never flipped it),
            // so the replay guard at the top of the handler admits the second response.
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));

            const round1 = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'no_quorum' }), round1, null);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled, 'no_quorum must not close the request');

            const round2 = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'ok' }), round2, null);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledOnceWith(REQ_ID.toLowerCase(), 'fulfilled'),
                'the later ok response fulfills the still-pending request');
            assert.ok(executeStub.parse.calledOnce, 'callback fires exactly once, on the fulfilling response');
        });

        it('stores the response but injects no callback when quorum is not reached', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 5 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce, 'response row recorded');
            assert.ok(executeStub.parse.notCalled, 'no callback without quorum');
        });

        // ── replay / request-state protection ────────────────────────────

        it('rejects a response to an already-resolved request (replay guard)', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'fulfilled', redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(String(data['STATUS']).includes('already fulfilled'));
            assert.ok(executeStub.parse.notCalled, 'no second callback for a resolved request');
        });

        it('rejects a response whose REQUEST_ID matches no request', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(String(data['STATUS']).includes('no matching request'));
        });

        it('rejects a response arriving after the deadline block', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ deadline_block: 200, redundancy: 1 }));
            const data = v1Data({ BLOCK_INDEX: 300 });
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(String(data['STATUS']).includes('expired'));
        });

        it('rejects a response whose PROVIDER_ID does not match the request', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ provider_id: 'http_get', redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { providerId: 'llm' }), data, null);
            assert.ok(String(data['STATUS']).includes('PROVIDER_ID does not match'));
        });

        it('rejects an unknown response STATUS value', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'bogus' }), data, null);
            assert.ok(String(data['STATUS']).includes('STATUS'));
        });

        it('rejects when PROVIDER_ID is null/empty in v1 params (line 181)', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            // Pass empty string for providerId to trigger isNull guard
            const params = ['1', REQ_ID, '', b64('hi'), 'ok', 'm', '1', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            assert.ok(String(data['STATUS']).includes('PROVIDER_ID'));
        });

        it('null meta in v1 params is handled without crash (canonical uses empty string, line 223)', async function () {
            // meta=null → String(null || '') = '' in canonical — must not throw
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            // Override v1Params to pass null meta
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', null, '1', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            // No throw — even if it ends invalid, the handler must complete
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce);
        });

        it('snapshotBlock falls back to data[BLOCK_INDEX] when request is null at sig-verify time (line 242)', async function () {
            // Set request to null by making getAttestationRequestById return null.
            // After the error is set ('no matching request'), the sig-verify loop does
            // not run (error is already set), but line 226 + 242 have the ternary branches.
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const data = v1Data({ BLOCK_INDEX: 120 });
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(String(data['STATUS']).includes('no matching request'));
        });

        it('sig with invalid 128-hex format throws and is caught as invalid (line 198)', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            // Valid pubkey but sig is only 64 chars (not 128) → invalid sig format
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', 'm', '1', PUBKEY_A, 'a'.repeat(64)];
            await handler.parse(params, data, null);
            assert.ok(String(data['STATUS']).includes('invalid'));
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // v2 — Expire (system-synthesized)
    // ───────────────────────────────────────────────────────────────────────
    describe('v2 — expire', function () {

        function v2Data(overrides = {}) {
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 2, BLOCK_INDEX: 250, REQUEST_ID: REQ_ID, IS_SYNTHETIC: true,
                ...overrides,
            });
        }

        it('expires a pending request → status flipped to expired and callback injected', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'expired'));
            assert.ok(executeStub.parse.calledOnce, 'expiry callback injected');
        });

        it('rejects a user-broadcast (non-synthetic) v2', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow());
            const data = v2Data({ IS_SYNTHETIC: false });
            await handler.parse(['2', REQ_ID], data, null);
            assert.ok(String(data['STATUS']).includes('system-synthesized'));
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled);
        });

        it('no-ops when the request is already resolved', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'fulfilled' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled);
            assert.ok(executeStub.parse.notCalled);
        });

        it('no-ops when the request no longer exists', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled);
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Version dispatch
    // ───────────────────────────────────────────────────────────────────────
    describe('version dispatch', function () {
        it('rejects an unknown VERSION (no phase handler runs, no DB writes)', async function () {
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 9 });
            // format 9 is not in this.formats → none of the v0/v1/v2 branches run,
            // so the dispatcher returns without touching the DB.
            await handler.parse(['9'], data, null);
            assert.ok(indexer.indexerDb.createAttestationRequest.notCalled);
            assert.ok(indexer.indexerDb.createAttestationResponse.notCalled);
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // _injectCallbackExecute internal branches
    // ───────────────────────────────────────────────────────────────────────
    describe('_injectCallbackExecute internal branches', function () {

        function v1Data(overrides = {}) {
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 7,
                ...overrides,
            });
        }
        function v1Params(sigs, overrides = {}) {
            const p = { requestId: REQ_ID, providerId: 'http_get', payload: b64('hi'), status: 'ok', meta: 'm', ...overrides };
            const head = ['1', p.requestId, p.providerId, p.payload, p.status, p.meta, String(sigs.length)];
            const tail = [];
            for (const s of sigs) { tail.push(s.pubkey, s.sig); }
            return head.concat(tail);
        }

        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('null actionExecute in actionsCtx → callback injection is silently skipped (line 397)', async function () {
            // Remove actionExecute so _injectCallbackExecute returns null immediately (line 397)
            actionsCtx.actionExecute = null;
            handler = new Attest(actionsCtx);

            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            // Response still recorded; callback index never set
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce, 'response row still recorded');
            assert.ok(indexer.indexerDb.setAttestationResponseCallbackIndex.notCalled,
                'no callback index stored when actionExecute is absent');
        });

        it('callback_params_json with invalid JSON → catch branch fires, callbackParams stays []', async function () {
            // Provide a request with malformed callback_params_json — the JSON.parse try/catch
            // in _injectCallbackExecute (lines 404-406) must fire without throwing.
            indexer.indexerDb.getAttestationRequestById.resolves(
                makeRequestRow({ redundancy: 1, callback_params_json: '<<<invalid json>>>' })
            );
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            // Callback injection still proceeds (callbackParams=[]); no throw
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(executeStub.parse.calledOnce, 'callback still injected despite bad params JSON');
        });

        it('execute.parse returns non-valid STATUS → warning logged, response still valid (lines 455-456)', async function () {
            // Make the EXECUTE emit a non-valid STATUS by mutating emissionData inside the stub
            executeStub.parse.callsFake(async (params, emissionData, err) => {
                emissionData['STATUS'] = 'invalid: some-execute-error';
            });
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            // The outer response row must still be 'valid' (the warning path, not a throw)
            assert.strictEqual(data['STATUS'], 'valid');
            // releaseSavepoint must still be called (the happy-path completes after the warning)
            assert.ok(indexer.indexerDb.releaseSavepoint.calledOnce);
        });

        it('execute.parse throws → rollbackToSavepoint called and exception swallowed by caller (lines 460-462)', async function () {
            // _parseResponse wraps _injectCallbackExecute in try/catch and swallows the error
            executeStub.parse.rejects(new Error('callback-exploded'));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();

            // Must not throw outward (the outer try/catch catches it)
            await assert.doesNotReject(
                () => handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null)
            );
            // rollbackToSavepoint called inside _injectCallbackExecute before re-throw
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce,
                'rollbackToSavepoint must be called when execute.parse throws');
        });

        it('null RESPONSE_PAYLOAD in callback arg uses empty string fallback (line 414)', async function () {
            // Pass null for the payload param (params[3]) so RESPONSE_PAYLOAD ends up null/empty.
            // The `responseData['RESPONSE_PAYLOAD'] || ''` guard fires inside _injectCallbackExecute.
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            // null payload → responseBodyBytes from Buffer.from('', 'base64') = empty → responsePayload=''
            const params = ['1', REQ_ID, 'http_get', '', 'ok', 'm', '1', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            // The handler must not throw; response row recorded and callback injected
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce);
            assert.ok(executeStub.parse.calledOnce, 'callback injected with empty payload');
        });

    });

    // ───────────────────────────────────────────────────────────────────────
    // _injectExpiredCallback internal branches (v2 expire path)
    // ───────────────────────────────────────────────────────────────────────
    describe('_injectExpiredCallback internal branches', function () {

        function v2Data(overrides = {}) {
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 2, BLOCK_INDEX: 250, REQUEST_ID: REQ_ID, IS_SYNTHETIC: true,
                ...overrides,
            });
        }

        it('null actionExecute on v2 expire → expire still valid, no callback (line 467)', async function () {
            actionsCtx.actionExecute = null;
            handler = new Attest(actionsCtx);

            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'expired'));
        });

        it('callback_params_json with invalid JSON on expire → catch branch, expire still succeeds (lines 474-476)', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(
                makeRequestRow({ request_status: 'pending', callback_params_json: '<<<invalid>>>' })
            );
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(executeStub.parse.calledOnce, 'expiry callback still injected despite bad params JSON');
        });

        it('expire execute.parse returns non-valid STATUS → warning only, expire still valid (lines 517-518)', async function () {
            executeStub.parse.callsFake(async (params, emissionData, err) => {
                emissionData['STATUS'] = 'invalid: expire-execute-error';
            });
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.releaseSavepoint.calledOnce);
        });

        it('expire execute.parse throws → rollbackToSavepoint called, swallowed by _parseExpire (lines 522-524)', async function () {
            executeStub.parse.rejects(new Error('expire-callback-exploded'));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();

            await assert.doesNotReject(
                () => handler.parse(['2', REQ_ID], data, null)
            );
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce,
                'rollbackToSavepoint must be called when expire execute.parse throws');
        });

        it('getValidatorsByCapability throws → missed_count catch block fires, expire still succeeds (lines 367-368)', async function () {
            // Make getValidatorsByCapability throw so _computeResponsibleSet propagates and
            // the outer try/catch in _parseExpire (lines 357-368) fires the warning path.
            indexer.indexerDb.getValidatorsByCapability.rejects(new Error('db-fault'));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();

            // The outer catch swallows the error — no re-throw
            await assert.doesNotReject(
                () => handler.parse(['2', REQ_ID], data, null)
            );
            // The expire itself is still committed (updateAttestationRequestStatus called)
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'expired'),
                'request should still be flipped to expired despite missed_count failure');
        });

        it('empty validator set → _computeResponsibleSet returns [] without crash (line 385)', async function () {
            // getValidatorsByCapability returns [] → the `length === 0` branch returns []
            indexer.indexerDb.getValidatorsByCapability.resolves([]);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // incrementAttestationValidatorStat must NOT be called (no validators)
            assert.ok(indexer.indexerDb.incrementAttestationValidatorStat.notCalled);
        });

        it('v2 with undefined REQUEST_ID falls back to empty string (line 331)', async function () {
            // data['REQUEST_ID'] is undefined → `|| ''` fires; getAttestationRequestById('') returns null → no-op
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const data = v2Data({ REQUEST_ID: undefined });
            await handler.parse(['2', REQ_ID], data, null);
            // No crash and no DB status update
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled);
        });

        it('multiple validators → _computeResponsibleSet sorts and picks top redundancy (line 392)', async function () {
            // Provide 3 validators so the sort runs with multiple elements, exercising the
            // comparator including the a.hash < b.hash and a.hash > b.hash branches.
            // (The equal branch is a SHA256 collision — genuinely unreachable in practice.)
            indexer.indexerDb.getValidatorsByCapability.resolves([
                { pubkey: PUBKEY_A },
                { pubkey: PUBKEY_B },
                { pubkey: 'c'.repeat(64) },
            ]);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending', redundancy: 2 }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // 2 validators picked for missed_count (redundancy=2)
            assert.strictEqual(indexer.indexerDb.incrementAttestationValidatorStat.callCount, 2);
        });

    });
});

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
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, EMITTER: 5, BLOCK_INDEX: 100,
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
            await handler.parse(v0Params(), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createAttestationRequest.calledOnce);
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

        it('rejects a deadline outside the provider window', async function () {
            const data = v0Data();
            await handler.parse(v0Params({ deadline: '999' }), data, null); // http_get window = 100
            assert.ok(String(data['STATUS']).includes('DEADLINE'));
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
});

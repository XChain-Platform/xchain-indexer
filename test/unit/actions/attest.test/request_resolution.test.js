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
// THE ATTEST HANDLER SUITE. One handler, split by behaviour across
// test/unit/actions/attest.test.js and its parts in test/unit/actions/attest.test/, every part under
// the same suite title so each full test title is what it was when the suite was
// one file. The shared setup, the wire builders and the fixture constants live in
// test/helpers/attest_fixture.js; the batch-rail fixtures in
// test/helpers/attest_batch_rail_fixture.js.
//
// This part: what a valid v1 response does to its request (callback, retry, replay
// guards), the v2 expiry, and version dispatch.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');
const { PUBKEY_A, SIG_A, REQ_ID, b64, makeRequestRow, setUpAttestHandler, v1Data, v1Params, verifyAllSignatures } = require('../../../helpers/attest_fixture.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let indexer, handler, executeStub;
function setUpHandler() {
    ({ indexer, handler, executeStub } = setUpAttestHandler());
}

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
        it('records both rounds and fulfills on the ok after an earlier retryable left it pending', async function () {
            // A retryable no_quorum round leaves the request pending; a later ok round
            // must also persist and fulfill it. This drives the REAL persistence path against a
            // fake `attests` store that models the post-fix schema (UNIQUE(action_index) only,
            // request_id+version NON-unique). The old UNIQUE(request_id, version) would have
            // rejected the second v1 INSERT and stranded the request; here both rounds coexist.
            const rows = [];
            indexer.indexerDb.createAttestationResponse = sinon.stub().callsFake(async (d) => {
                const ai  = d['ACTION_INDEX'];
                let row = rows.find(r => r.action_index === ai);   // UNIQUE(action_index)
                if(!row){ row = { action_index: ai }; rows.push(row); }
                row.version         = 1;
                row.request_id      = String(d['REQUEST_ID'] || '').toLowerCase();
                row.response_status = d['RESPONSE_STATUS'];
            });
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));

            const round1 = v1Data({ ACTION_INDEX: 7 });
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'no_quorum' }), round1, null);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled, 'no_quorum must not close the request');

            const round2 = v1Data({ ACTION_INDEX: 8 });
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'ok' }), round2, null);

            // Both v1 rounds coexist as distinct rows under the same request_id.
            const v1Rows = rows.filter(r => r.version === 1 && r.request_id === REQ_ID.toLowerCase());
            assert.strictEqual(v1Rows.length, 2, 'both the no_quorum and ok rounds are recorded');
            assert.deepStrictEqual(v1Rows.map(r => r.response_status).sort(), ['no_quorum', 'ok']);
            assert.notStrictEqual(v1Rows[0].action_index, v1Rows[1].action_index, 'distinct action_index per round');

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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
        it('null meta in v1 params is handled without crash (canonical uses empty string, line 223)', async function () {
            // meta=null → String(null || '') = '' in canonical; must not throw
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            // Override v1Params to pass null meta
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', null, '1', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            // No throw: even if it ends invalid, the handler must complete
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
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    // ───────────────────────────────────────────────────────────────────────
    // v2: Expire (system-synthesized)
    // ───────────────────────────────────────────────────────────────────────
    describe('v2: expire', function () {

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
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
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

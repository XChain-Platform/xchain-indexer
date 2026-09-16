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
// This part: the internal branches of the callback injected on a v1 response and on a
// v2 expiry.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');
const Attest = require('../../../../src/actions/attest/index.js');
// Same module instance Attest holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../../src/consensus/ed25519.js');
const { PUBKEY_A, PUBKEY_B, SIG_A, REQ_ID, b64, makeRequestRow, setUpAttestHandler } = require('../../../helpers/attest_fixture.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let indexer, actionsCtx, handler, executeStub;
function setUpHandler() {
    ({ indexer, actionsCtx, handler, executeStub } = setUpAttestHandler());
}

// ───────────────────────────────────────────────────────────────────────
// injectCallbackExecute internal branches
// ───────────────────────────────────────────────────────────────────────
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

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('_injectCallbackExecute internal branches', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('null actionExecute in actionsCtx → callback injection is silently skipped (line 397)', async function () {
            // Remove actionExecute so injectCallbackExecute returns null immediately (line 397)
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
            // Provide a request with malformed callback_params_json; the JSON.parse try/catch
            // in injectCallbackExecute (lines 404-406) must fire without throwing.
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('_injectCallbackExecute internal branches', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('execute.parse throws → rollbackToSavepoint called and exception swallowed by caller (lines 460-462)', async function () {
            // parseResponse wraps injectCallbackExecute in try/catch and swallows the error
            executeStub.parse.rejects(new Error('callback-exploded'));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();

            // Must not throw outward (the outer try/catch catches it)
            await assert.doesNotReject(
                () => handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null)
            );
            // rollbackToSavepoint called inside injectCallbackExecute before re-throw
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce,
                'rollbackToSavepoint must be called when execute.parse throws');
        });

        it('null RESPONSE_PAYLOAD in callback arg uses empty string fallback (line 414)', async function () {
            // Pass null for the payload param (params[3]) so RESPONSE_PAYLOAD ends up null/empty.
            // The `responseData['RESPONSE_PAYLOAD'] || ''` guard fires inside injectCallbackExecute.
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            // null payload → responseBodyBytes from Buffer.from('', 'base64') = empty → responsePayload=''
            const params = ['1', REQ_ID, 'http_get', '', 'ok', 'm', '1', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            // The handler must not throw; response row recorded and callback injected
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce);
            assert.ok(executeStub.parse.calledOnce, 'callback injected with empty payload');
        });

        it('savepoint name is unique per injected callback (suffixed with emission action_index)', async function () {
            indexer.indexerDb.createActionIndex.resolves(42);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            assert.ok(indexer.indexerDb.createSavepoint.calledOnce);
            assert.strictEqual(indexer.indexerDb.createSavepoint.firstCall.args[0], 'attestation_callback_42',
                'savepoint name must embed the emission action_index so repeated callbacks in one tx never collide');
        });
    });
});

function v2Data(overrides = {}) {
    return createBaseData({
        ACTION: 'ATTEST', FORMAT: 2, BLOCK_INDEX: 250, REQUEST_ID: REQ_ID, IS_SYNTHETIC: true,
        ...overrides,
    });
}

// ───────────────────────────────────────────────────────────────────────
// injectExpiredCallback internal branches (v2 expire path)
// ───────────────────────────────────────────────────────────────────────
describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('_injectExpiredCallback internal branches', function () {
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('_injectExpiredCallback internal branches', function () {
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

        it('expire savepoint name is unique per injected callback (suffixed with emission action_index)', async function () {
            indexer.indexerDb.createActionIndex.resolves(77);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);

            assert.ok(indexer.indexerDb.createSavepoint.calledOnce);
            assert.strictEqual(indexer.indexerDb.createSavepoint.firstCall.args[0], 'attestation_expire_callback_77',
                'expire savepoint name must embed the emission action_index');
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('_injectExpiredCallback internal branches', function () {
        it('getValidatorsByCapability throws → missed_count catch block fires, expire still succeeds (lines 367-368)', async function () {
            // Make getValidatorsByCapability throw so computeResponsibleSet propagates and
            // the outer try/catch in parseExpire (lines 357-368) fires the warning path.
            indexer.indexerDb.getValidatorsByCapability.rejects(new Error('db-fault'));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();

            // The outer catch swallows the error (no re-throw)
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
            // (The equal branch is a SHA256 collision, genuinely unreachable in practice.)
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

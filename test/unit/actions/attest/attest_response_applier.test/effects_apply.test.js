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
// THE HUB-MIRROR ATTEST RESPONSE APPLIER, the §4.4 effects of a verified row
// (response row, terminal flip, callback, the synthetic action and its hash) and
// the rows the applier must skip without writing anything.
//
// The two units under test, why signature verification is stubbed, and the
// shared rows (./helpers/rows.js) are described in ../attest_response_applier.test.js.
// The per-test handler and the synthesized-action data come from
// ./helpers/effects_fixture.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const ed25519 = require('../../../../../src/consensus/ed25519.js');
const { SYNTH_TAGS, synthesizeTxHash } = require('../../../../../src/consensus/exec_context.js');

const { PUBKEY_A, SIG_A, REQ_ID, BODY, BODY_HASH, BLOCK_TIME } = require('./helpers/rows.js');
const { applyData, setupEffects } = require('./helpers/effects_fixture.js');

// Consecutive sibling blocks under the one suite title, so every full test title
// is the one the suite has always reported.

// ------------------------------------------------------------------- the effects

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    let indexer, handler, executeStub;

    describe('§4.4 effects (attest.js _applyMirroredResponse)', function () {
        beforeEach(function () { ({ indexer, handler, executeStub } = setupEffects()); });

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
    });
});

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    let indexer, handler, executeStub;

    describe('§4.4 effects (attest.js _applyMirroredResponse)', function () {
        beforeEach(function () { ({ indexer, handler, executeStub } = setupEffects()); });

        afterEach(function () { sinon.restore(); });

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
    });
});

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    let indexer, handler, executeStub;

    describe('§4.4 effects (attest.js _applyMirroredResponse)', function () {
        beforeEach(function () { ({ indexer, handler, executeStub } = setupEffects()); });

        afterEach(function () { sinon.restore(); });

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
    });
});

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    let indexer, handler, executeStub;

    describe('§4.4 effects (attest.js _applyMirroredResponse)', function () {
        beforeEach(function () { ({ indexer, handler, executeStub } = setupEffects()); });

        afterEach(function () { sinon.restore(); });

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
    });
});

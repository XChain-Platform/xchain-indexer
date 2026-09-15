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
// THE HUB-MIRROR ATTEST RESPONSE APPLIER, the §4.4 effects at apply time: the
// re-gated mirror era and pending state, the errored flip, the fee settle and the
// retired broadcast-fee carve-out, the relay-leg callback deferral, and the
// chain-path v1 dispatch the mirror marker must not touch.
//
// The two units under test, why signature verification is stubbed, and the
// shared rows (./helpers/rows.js) are described in ../attest_response_applier.test.js.
// The per-test handler and the synthesized-action data come from
// ./helpers/effects_fixture.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../../../fixtures/mocks');

const arm     = require('../../../../../src/attest_response_mirror_activation.js');
const attestBcastFee  = require('../../../../../src/attest_broadcast_fee_activation.js');

const { PUBKEY_A, SIG_A, REQ_ID, BODY, BLOCK_TIME, requestRow } = require('./helpers/rows.js');
const { applyData, setupEffects } = require('./helpers/effects_fixture.js');

// Consecutive sibling blocks under the one suite title, so every full test title
// is the one the suite has always reported.

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    let indexer, handler, executeStub;

    describe('§4.4 effects (attest.js _applyMirroredResponse)', function () {
        beforeEach(function () { ({ indexer, handler, executeStub } = setupEffects()); });

        afterEach(function () { sinon.restore(); });

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
    });
});

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    let indexer, handler, executeStub;

    describe('§4.4 effects (attest.js _applyMirroredResponse)', function () {
        beforeEach(function () { ({ indexer, handler, executeStub } = setupEffects()); });

        afterEach(function () { sinon.restore(); });

        it('settles the request fee at the synthesized action, which carries BLOCK_TIME (D60)', async function () {
            // The fee-ORACLE read is the first reason the synthesized action must
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
    });
});

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    let indexer, handler, executeStub;

    describe('§4.4 effects (attest.js _applyMirroredResponse)', function () {
        beforeEach(function () { ({ indexer, handler, executeStub } = setupEffects()); });

        afterEach(function () { sinon.restore(); });

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
    });
});

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    let indexer, handler, executeStub;

    describe('§4.4 effects (attest.js _applyMirroredResponse)', function () {
        beforeEach(function () { ({ indexer, handler, executeStub } = setupEffects()); });

        afterEach(function () { sinon.restore(); });

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

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
// This part: the response-mirror flag day, which retires the chain leg of the
// response and the broadcast-fee carve-out with it.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');
const attestBcastFee = require('../../../../src/actions/attest/attest_broadcast_fee_gate.js');
const arm = require('../../../../src/attest_response_mirror_activation.js');
// Same module instance Attest holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../../src/consensus/ed25519.js');
const { PUBKEY_A, PUBKEY_B, SIG_A, REQ_ID, b64, makeRequestRow, setUpAttestHandler } = require('../../../helpers/attest_fixture.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let indexer, handler, executeStub;
function setUpHandler() {
    ({ indexer, handler, executeStub } = setUpAttestHandler());
}

function v1Data(overrides = {}) {
    return createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60, ...overrides });
}
function v1Params(sigs, status = 'ok') {
    const head = ['1', REQ_ID, 'http_get', b64('hello'), status, 'm', String(sigs.length)];
    const tail = [];
    for (const s of sigs) { tail.push(s.pubkey, s.sig); }
    return head.concat(tail);
}

const FEE_PAYER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const COIN_USD   = '50000';
const XCHAIN_USD = '2.5';

function rewardsByType(type) {
    return indexer.indexerDb.createValidatorReward.getCalls()
        .filter(c => c.args[2] === type)
        .map(c => ({ pubkey: c.args[0], amount: String(c.args[3]) }));
}
function feeRequestRow(overrides = {}) {
    return makeRequestRow({
        action_index: 42, fee_amount: '6.00000000', fee_payer: FEE_PAYER,
        redundancy: 1, ...overrides,
    });
}

// ------------------------------------------------------- the response-mirror flag day

// Above the height a response reaches every indexer through the hub mirror, so the
// chain leg of the response is retired: an on-chain v1 is refused, and the
// broadcast-fee carve-out that reimbursed the leader's miner fee goes with it because
// nobody broadcasts anything to be reimbursed for.
describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST_RESPONSE_MIRROR flag day: the chain handler and the fee', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('an on-chain v1 for a mirror-era request is invalid, with the pinned status', async function () {
            arm.isResponseMirrorActive.returns(true);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            // Consensus state: this exact string is the stored verdict a replay
            // re-derives, so it is pinned rather than matched loosely.
            assert.strictEqual(data['STATUS'], 'invalid: ATTEST v1 after mirror activation');
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce,
                'the audit row still records the rejected broadcast, as every other v1 refusal does');
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false,
                'above all it must not close the request: the mirror row is what closes it');
            assert.strictEqual(executeStub.parse.called, false,
                'and no callback fires, or a stale hub could double-deliver');
        });

        it('the same v1 for a LEGACY-era request is served on chain exactly as before', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID, 'fulfilled', 100));
            assert.ok(executeStub.parse.calledOnce);
        });

        it('the era is read from the REQUEST block, through the one shared predicate', function () {
            arm.isResponseMirrorActive.returns(true);
            assert.strictEqual(handler.isMirrorEraRequest(makeRequestRow({ block_index: 90 })), true);
            assert.ok(arm.isResponseMirrorActive.calledWith(90, 'regtest'),
                'the request row block, never the response action block and never a hub-stated one');
            assert.strictEqual(handler.isMirrorEraRequest(null), false);
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST_RESPONSE_MIRROR flag day: the chain handler and the fee', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('the gate outranks every other request-derived verdict on the same wire', async function () {
            // Each of these rejects on its own below the height. Above it the era answers
            // first, so one wire cannot record two different reasons depending on the
            // request's incidental state.
            arm.isResponseMirrorActive.returns(true);
            for (const row of [makeRequestRow({ request_status: 'fulfilled' }),
                               makeRequestRow({ provider_id: 'llm' }),
                               makeRequestRow({ deadline_block: 1 })]) {
                indexer.indexerDb.getAttestationRequestById.resolves(row);
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['STATUS'], 'invalid: ATTEST v1 after mirror activation');
            }
            // A wire naming no request at all still reports that, because there is no
            // request row to read an era from.
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const orphan = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), orphan, null);
            assert.strictEqual(orphan['STATUS'], 'invalid: REQUEST_ID (no matching request)');
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST_RESPONSE_MIRROR flag day: the chain handler and the fee', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        describe('broadcast-fee retirement', function () {
            beforeEach(function () {
                // The carve-out flag day is ARMED throughout this describe: what is under
                // test is that the mirror era retires it anyway, not that an unarmed gate
                // pays nothing.
                attestBcastFee.isAttestBroadcastFeeActive.returns(true);
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                sinon.stub(indexer.util, 'getFeeOraclePrices').resolves({
                    coinUsdPrice: COIN_USD, xchainUsdPrice: XCHAIN_USD, oracleRound: 7,
                });
            });

            it('LEGACY era: the carve-out still pays 2 and the split gets 4', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow());
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.deepStrictEqual(rewardsByType('attest_bcast'), [{ pubkey: PUBKEY_A, amount: '2' }]);
                assert.deepStrictEqual(rewardsByType('attest_fee'), [{ pubkey: PUBKEY_A, amount: '4' }]);
            });

            it('MIRROR era: no attest_bcast row, and the WHOLE escrow splits', async function () {
                // The exact amounts are the point of the row: retiring the carve-out
                // changes real reward amounts above the height, so 4 must become 6.
                arm.isResponseMirrorActive.returns(true);
                const request = feeRequestRow();
                const data = createBaseData({
                    ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60,
                    BLOCK_TIME: 1700000000,
                });
                // Driven through the settle directly: above the height the chain handler
                // refuses the wire, so the settle is reached by the mirror applier, and the
                // retirement has to live where BOTH callers pass through.
                await handler.settleRequestFee(request, data, 'fulfilled');

                assert.deepStrictEqual(rewardsByType('attest_bcast'), [],
                    'nobody broadcast anything, so there is no miner fee to reimburse');
                assert.deepStrictEqual(rewardsByType('attest_fee'), [{ pubkey: PUBKEY_A, amount: '6' }],
                    'the whole escrow splits, so the per-signer amount RISES by the retired carve-out');
                assert.strictEqual(indexer.util.getFeeOraclePrices.called, false,
                    'and the oracle is never read for a conversion that cannot apply');
                assert.strictEqual(String(indexer.indexerDb.createCredit.firstCall.args[2]), '6.00000000',
                    'the pool credit is the full escrow either way');
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST_RESPONSE_MIRROR flag day: the chain handler and the fee', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        describe('broadcast-fee retirement', function () {
            beforeEach(function () {
                // The carve-out flag day is ARMED throughout this describe: what is under
                // test is that the mirror era retires it anyway, not that an unarmed gate
                // pays nothing.
                attestBcastFee.isAttestBroadcastFeeActive.returns(true);
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                sinon.stub(indexer.util, 'getFeeOraclePrices').resolves({
                    coinUsdPrice: COIN_USD, xchainUsdPrice: XCHAIN_USD, oracleRound: 7,
                });
            });

            it('MIRROR era at REDUNDANCY 3: every signer gets an equal share of the whole escrow', async function () {
                arm.isResponseMirrorActive.returns(true);
                indexer.indexerDb.getValidatorsByCapability.resolves([
                    { pubkey: PUBKEY_A }, { pubkey: PUBKEY_B }, { pubkey: 'c'.repeat(64) },
                ]);
                const data = createBaseData({
                    ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60, BLOCK_TIME: 1700000000,
                });
                await handler.settleRequestFee(feeRequestRow({ redundancy: 3 }), data, 'fulfilled');
                const split = rewardsByType('attest_fee');
                assert.strictEqual(split.length, 3);
                // 6/3 exactly, where the legacy era would have paid (6-2)/3 = 1.33333333.
                for (const row of split) assert.strictEqual(row.amount, '2');
                assert.deepStrictEqual(rewardsByType('attest_bcast'), []);
            });

            it('the retirement keys on the REQUEST block, not the settling action block', async function () {
                // A request admitted below the height settles under the legacy rules
                // however late its response lands, which is what keeps replay stable.
                arm.isResponseMirrorActive.callsFake((block) => Number(block) >= 95);
                const data = createBaseData({
                    ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60, BLOCK_TIME: 1700000000,
                });
                await handler.settleRequestFee(feeRequestRow({ block_index: 90 }), data, 'fulfilled');
                assert.strictEqual(rewardsByType('attest_bcast').length, 1,
                    'request block 90 is below 95, so the legacy carve-out still applies at settle block 100');
            });
        });
    });
});

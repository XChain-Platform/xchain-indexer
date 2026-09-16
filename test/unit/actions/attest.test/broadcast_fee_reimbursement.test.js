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
// This part: the leader broadcast-fee reimbursement carved out of a request fee.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const crypto = require('crypto');

const attestBcastFee = require('../../../../src/actions/attest/attest_broadcast_fee_gate.js');
// Same module instance Attest holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../../src/consensus/ed25519.js');
const { PUBKEY_A, PUBKEY_B, SIG_A, SIG_B, REQ_ID, makeRequestRow, setUpAttestHandler, FEE_PAYER, PUBKEY_C, SIG_C, feeRequestRow, v1FeeData, v1FeeParams, COIN_USD, XCHAIN_USD } = require('../../../helpers/attest_fixture.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let indexer, handler;
function setUpHandler() {
    ({ indexer, handler } = setUpAttestHandler());
}

function rewardsByType(type) {
    return indexer.indexerDb.createValidatorReward.getCalls()
        .filter(c => c.args[2] === type)
        .map(c => ({ pubkey: c.args[0], roundRef: c.args[1], amount: String(c.args[3]), block: c.args[4] }));
}

// Leader broadcast-fee reimbursement. The escrow pays the
// broadcaster its native-coin cost back BEFORE the equal split, converted to XCHAIN
// at the settle block's oracle price, bounded by a per-provider cap, and gated on a
// flag-day so replay below the height is byte-identical to the pre-flag ledger.
describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('§11: leader broadcast-fee reimbursement', function () {
            beforeEach(function () {
                sinon.stub(ed25519, 'verify').returns(true);
                attestBcastFee.isAttestBroadcastFeeActive.returns(true);
                // Production XCHAIN genesis is 8dp; the carve-out and the split floor to the
                // same grid, so assert on that grid rather than the 0dp regtest default.
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                sinon.stub(indexer.util, 'getFeeOraclePrices').resolves({
                    coinUsdPrice: COIN_USD, xchainUsdPrice: XCHAIN_USD, oracleRound: 7,
                });
            });

            it('pays the lowest-hash responsible member a converted reimbursement, then splits the rest', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');

                const bcast = rewardsByType('attest_bcast');
                assert.strictEqual(bcast.length, 1, 'one broadcast reimbursement row');
                assert.strictEqual(bcast[0].pubkey, PUBKEY_A, 'paid to the responsible set head');
                assert.strictEqual(bcast[0].amount, '2', '0.0001 BTC at 50000/2.5 = 2 XCHAIN');
                assert.strictEqual(bcast[0].roundRef, 42, 'keyed on the REQUEST action_index');
                assert.strictEqual(bcast[0].block, data['BLOCK_INDEX'], 'stamped at the settle block');

                const split = rewardsByType('attest_fee');
                assert.strictEqual(split.length, 1);
                assert.strictEqual(split[0].amount, '4', 'escrow 6 minus the 2 carved out');

                // The pool credit is still the FULL escrow; the rows only reference it.
                assert.strictEqual(String(indexer.indexerDb.createCredit.firstCall.args[2]), '6.00000000');
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('§11: leader broadcast-fee reimbursement', function () {
            // The hash-sorted responsible set the handler derives for REQ_ID over
            // {A,B,C}: element 0 is the broadcaster the carve-out must pay.
            function hashOrder(pubkeys) {
                return pubkeys
                    .map(pk => ({ pk, h: crypto.createHash('sha256').update(REQ_ID, 'utf8').update(pk, 'utf8').digest('hex') }))
                    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
                    .map(v => v.pk);
            }

            beforeEach(function () {
                sinon.stub(ed25519, 'verify').returns(true);
                attestBcastFee.isAttestBroadcastFeeActive.returns(true);
                // Production XCHAIN genesis is 8dp; the carve-out and the split floor to the
                // same grid, so assert on that grid rather than the 0dp regtest default.
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                sinon.stub(indexer.util, 'getFeeOraclePrices').resolves({
                    coinUsdPrice: COIN_USD, xchainUsdPrice: XCHAIN_USD, oracleRound: 7,
                });
            });

            it('the reimbursement is ON TOP of the broadcaster share (REDUNDANCY 3)', async function () {
                indexer.indexerDb.getValidatorsByCapability.resolves([
                    { pubkey: PUBKEY_A }, { pubkey: PUBKEY_B }, { pubkey: PUBKEY_C },
                ]);
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 3 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                    { pubkey: PUBKEY_C, sig: SIG_C },
                ]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');

                const leader = hashOrder([PUBKEY_A, PUBKEY_B, PUBKEY_C])[0];
                const bcast  = rewardsByType('attest_bcast');
                assert.strictEqual(bcast.length, 1);
                assert.strictEqual(bcast[0].pubkey, leader, 'lowest SHA256(request_id||pubkey) wins');
                assert.strictEqual(bcast[0].amount, '2');

                const split = rewardsByType('attest_fee');
                assert.strictEqual(split.length, 3, 'every responsible member still gets a share');
                // (6 - 2) / 3 floored to 8dp
                for (const row of split) assert.strictEqual(row.amount, '1.33333333');
                // The leader holds both rows, which is exactly "additionally receives".
                assert.ok(split.some(r => r.pubkey === leader));
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('§11: leader broadcast-fee reimbursement', function () {
            beforeEach(function () {
                sinon.stub(ed25519, 'verify').returns(true);
                attestBcastFee.isAttestBroadcastFeeActive.returns(true);
                // Production XCHAIN genesis is 8dp; the carve-out and the split floor to the
                // same grid, so assert on that grid rather than the 0dp regtest default.
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                sinon.stub(indexer.util, 'getFeeOraclePrices').resolves({
                    coinUsdPrice: COIN_USD, xchainUsdPrice: XCHAIN_USD, oracleRound: 7,
                });
            });

            it('a missing/stale oracle price reimburses 0 and never wedges the settle', async function () {
                indexer.util.getFeeOraclePrices.resolves({ error: 'no current oracle price for BTC/USD' });
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                assert.strictEqual(data['STATUS'], 'valid', 'settle still completes');
                assert.strictEqual(rewardsByType('attest_bcast').length, 0);
                const split = rewardsByType('attest_fee');
                assert.strictEqual(split.length, 1);
                assert.strictEqual(split[0].amount, '6', 'whole escrow falls through to the split');
            });

            it('an oracle read that THROWS reimburses 0 rather than failing the block', async function () {
                indexer.util.getFeeOraclePrices.rejects(new Error('price table unavailable'));
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(rewardsByType('attest_bcast').length, 0);
                assert.strictEqual(rewardsByType('attest_fee')[0].amount, '6');
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('§11: leader broadcast-fee reimbursement', function () {
            beforeEach(function () {
                sinon.stub(ed25519, 'verify').returns(true);
                attestBcastFee.isAttestBroadcastFeeActive.returns(true);
                // Production XCHAIN genesis is 8dp; the carve-out and the split floor to the
                // same grid, so assert on that grid rather than the 0dp regtest default.
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                sinon.stub(indexer.util, 'getFeeOraclePrices').resolves({
                    coinUsdPrice: COIN_USD, xchainUsdPrice: XCHAIN_USD, oracleRound: 7,
                });
            });

            it('clamps the reimbursement to the escrow when the escrow is thinner than the allowance', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(
                    feeRequestRow({ redundancy: 1, fee_amount: '0.50000000' }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                const bcast = rewardsByType('attest_bcast');
                assert.strictEqual(bcast.length, 1);
                assert.strictEqual(bcast[0].amount, '0.5', 'never pays out more than was escrowed');
                assert.strictEqual(rewardsByType('attest_fee').length, 0, 'nothing left to split');
            });

            it('below the flag-day the whole escrow still goes to the split (replay parity)', async function () {
                attestBcastFee.isAttestBroadcastFeeActive.returns(false);
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                assert.strictEqual(rewardsByType('attest_bcast').length, 0);
                assert.strictEqual(rewardsByType('attest_fee')[0].amount, '6');
                assert.ok(indexer.util.getFeeOraclePrices.notCalled, 'no oracle read below the gate');
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('§11: leader broadcast-fee reimbursement', function () {
            beforeEach(function () {
                sinon.stub(ed25519, 'verify').returns(true);
                attestBcastFee.isAttestBroadcastFeeActive.returns(true);
                // Production XCHAIN genesis is 8dp; the carve-out and the split floor to the
                // same grid, so assert on that grid rather than the 0dp regtest default.
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                sinon.stub(indexer.util, 'getFeeOraclePrices').resolves({
                    coinUsdPrice: COIN_USD, xchainUsdPrice: XCHAIN_USD, oracleRound: 7,
                });
            });

            it('a feeless request pays no reimbursement (nothing is escrowed to carve from)', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });

            it('a non-ok terminal status refunds the payer and pays no reimbursement', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }], 'expired'), data, null);

                assert.strictEqual(rewardsByType('attest_bcast').length, 0);
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
                assert.strictEqual(indexer.indexerDb.createCredit.firstCall.args[3], FEE_PAYER);
            });

            it('reads the oracle at the SETTLE block, not the request block', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData({ BLOCK_INDEX: 175, BLOCK_TIME: 1700009999 });
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                assert.ok(indexer.util.getFeeOraclePrices.calledOnce);
                const [, coin, blockIndex, refTime] = indexer.util.getFeeOraclePrices.firstCall.args;
                assert.strictEqual(coin, 'BTC');
                assert.strictEqual(blockIndex, 175, 'request row block_index is 90; the settle block is what counts');
                assert.strictEqual(refTime, 1700009999);
            });
        });
    });
});

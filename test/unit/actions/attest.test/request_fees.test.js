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
// This part: request fees, from validation and escrow on the v0 to settlement on the
// terminal flip and the refund on expiry.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');
// Same module instance Attest holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../../src/consensus/ed25519.js');
const { PUBKEY_A, PUBKEY_B, SIG_A, SIG_B, REQ_ID, makeRequestRow, setUpAttestHandler, FEE_PAYER, POOL, PUBKEY_C, SIG_C, v0FeeData, v0FeeParams, feeRequestRow, v1FeeData, v1FeeParams } = require('../../../helpers/attest_fixture.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let indexer, handler;
function setUpHandler() {
    ({ indexer, handler } = setUpAttestHandler());
}

// ───────────────────────────────────────────────────────────────────────
// Request fees (FEE_TICK|FEE_AMOUNT optional trailing fields)
// ───────────────────────────────────────────────────────────────────────
function fundFeePayer() {
    indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 7 });
    indexer.indexerDb.getAddressBalances.resolves({ 7: '100.00000000' });
}

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('v0: fee validation + escrow', function () {
            it('valid fee → escrows + debits FEE_AMOUNT from FEE_PAYER, STATUS valid', async function () {
                fundFeePayer();
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '5'), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createDebit.calledOnce, 'fee debited');
                assert.ok(indexer.indexerDb.createEscrow.calledOnce, 'fee escrowed');
                const [, tick, amount, address] = indexer.indexerDb.createEscrow.firstCall.args;
                assert.strictEqual(tick, 'XCHAIN');
                assert.strictEqual(String(amount), '5');
                assert.strictEqual(address, FEE_PAYER);
                assert.ok(indexer.indexerDb.updateBalances.called, 'balances refreshed after escrow');
            });

            it('rejects a non-XCHAIN FEE_TICK (v1 rule: GAS tick only)', async function () {
                fundFeePayer();
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'MYTOKEN', '5'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: FEE_TICK (only'));
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
            });

            it('rejects FEE_AMOUNT finer than the GAS tick decimals (9 dp vs production 8)', async function () {
                fundFeePayer();
                // Production XCHAIN genesis is issued with 8 decimals; 8 is also the
                // hard ceiling the equal split floors to.
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '1.123456789'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: FEE_AMOUNT (precision'));
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
            });

            it('rejects FEE_AMOUNT finer than a low-decimal GAS tick (1.234 vs 2 dp)', async function () {
                fundFeePayer();
                indexer.indexerDb.getTokenDecimalPrecision.resolves(2);
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '1.234'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: FEE_AMOUNT (precision'));
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
            });

            it('accepts FEE_AMOUNT at exactly the GAS tick decimals (2 dp)', async function () {
                fundFeePayer();
                indexer.indexerDb.getTokenDecimalPrecision.resolves(2);
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '1.23'), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.calledOnce);
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('v0: fee validation + escrow', function () {
            it('rejects a fractional FEE_AMOUNT against the decimals-0 regtest GAS tick', async function () {
                fundFeePayer(); // mock getTokenDecimalPrecision defaults to 0 (regtest GAS)
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '1.5'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: FEE_AMOUNT (precision'));
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
            });

            it('rejects FEE_AMOUNT > 0 without FEE_TICK', async function () {
                fundFeePayer();
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, '', '5'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: FEE_TICK (required'));
            });

            it('rejects when FEE_PAYER cannot cover the fee', async function () {
                indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 7 });
                indexer.indexerDb.getAddressBalances.resolves({ 7: '1.00000000' });
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '5'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: insufficient funds (FEE_AMOUNT)'));
                assert.ok(indexer.indexerDb.createEscrow.notCalled, 'nothing escrowed on an invalid request');
            });

            it('feeless request (8-field wire format) stays valid with zero ledger writes', async function () {
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createDebit.notCalled);
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
            });

            it("FEE_AMOUNT '0' is treated as feeless (no escrow, no balance read)", async function () {
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '0'), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
                assert.ok(indexer.indexerDb.getAddressBalances.notCalled, 'no funding check for a zero fee');
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('v1: fee settlement on the terminal flip', function () {
            beforeEach(function () {
                sinon.stub(ed25519, 'verify').returns(true);
            });

            it('fulfilled → escrow released, REWARD pool credited, validator_rewards written', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');

                // escrow release: one negative-amount escrow row against FEE_PAYER
                assert.ok(indexer.indexerDb.createEscrow.calledOnce, 'escrow release row written');
                const [, escTick, escAmount, escAddr] = indexer.indexerDb.createEscrow.firstCall.args;
                assert.strictEqual(escTick, 'XCHAIN');
                assert.ok(Number(escAmount) < 0, 'escrow amount is negative (release)');
                assert.strictEqual(escAddr, FEE_PAYER);

                // pool credit for the full fee
                assert.ok(indexer.indexerDb.createCredit.calledOnce);
                const [, crTick, crAmount, crAddr] = indexer.indexerDb.createCredit.firstCall.args;
                assert.strictEqual(crTick, 'XCHAIN');
                assert.strictEqual(String(crAmount), '6.00000000');
                assert.strictEqual(crAddr, POOL);

                // one reward row, keyed on the REQUEST's action_index
                assert.ok(indexer.indexerDb.createValidatorReward.calledOnce);
                const [pk, roundRef, rewardType, perValidator] = indexer.indexerDb.createValidatorReward.firstCall.args;
                assert.strictEqual(pk, PUBKEY_A);
                assert.strictEqual(roundRef, 42);
                assert.strictEqual(rewardType, 'attest_fee');
                assert.strictEqual(String(perValidator), '6');
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('v1: fee settlement on the terminal flip', function () {
            beforeEach(function () {
                sinon.stub(ed25519, 'verify').returns(true);
            });

            it('fulfilled at REDUNDANCY=3 → equal floor split, remainder dust stays in the pool', async function () {
                indexer.indexerDb.getValidatorsByCapability.resolves([
                    { pubkey: PUBKEY_A }, { pubkey: PUBKEY_B }, { pubkey: PUBKEY_C },
                ]);
                indexer.indexerDb.getAttestationRequestById.resolves(
                    feeRequestRow({ redundancy: 3, fee_amount: '1.00000001' }));
                // settleRequestFee reads gasDecimals to compute feeCap = min(8, gasDecimals).
                // Production XCHAIN genesis is 8 dp; floor each share to 8 dp.
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                const data = v1FeeData();
                await handler.parse(v1FeeParams([
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                    { pubkey: PUBKEY_C, sig: SIG_C },
                ]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 3);
                for (const call of indexer.indexerDb.createValidatorReward.getCalls())
                    assert.strictEqual(String(call.args[3]), '0.33333333', 'floor to GAS decimals');
                // pool was credited the FULL fee; rewards reference 0.99999999 (dust stays)
                assert.strictEqual(String(indexer.indexerDb.createCredit.firstCall.args[2]), '1.00000001');
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('v1: fee settlement on the terminal flip', function () {
            beforeEach(function () {
                sinon.stub(ed25519, 'verify').returns(true);
            });

            it("terminal non-ok ('errored') → fee refunds to FEE_PAYER, no rewards", async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }], 'expired'), data, null);
                assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'errored'));
                assert.ok(indexer.indexerDb.createCredit.calledOnce);
                const [, , crAmount, crAddr] = indexer.indexerDb.createCredit.firstCall.args;
                assert.strictEqual(String(crAmount), '6.00000000');
                assert.strictEqual(crAddr, FEE_PAYER, 'refund goes to the payer, not the pool');
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });

            it("retryable status ('no_quorum') → fee stays escrowed, zero ledger movement", async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }], 'no_quorum'), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
                assert.ok(indexer.indexerDb.createCredit.notCalled);
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });

            it('fulfilled FEELESS request → no fee ledger writes, no rewards', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('E1: request fees', function () {
        describe('v2: fee refund on expiry', function () {

            function v2FeeData(overrides = {}) {
                return createBaseData({
                    ACTION: 'ATTEST', FORMAT: 2, BLOCK_INDEX: 250, REQUEST_ID: REQ_ID, IS_SYNTHETIC: true,
                    ...overrides,
                });
            }

            it('expiry of a fee-bearing request refunds the escrow to FEE_PAYER', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ request_status: 'pending' }));
                const data = v2FeeData();
                await handler.parse(['2', REQ_ID], data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.calledOnce, 'escrow release row written');
                assert.ok(Number(indexer.indexerDb.createEscrow.firstCall.args[2]) < 0);
                assert.ok(indexer.indexerDb.createCredit.calledOnce);
                const [, , crAmount, crAddr] = indexer.indexerDb.createCredit.firstCall.args;
                assert.strictEqual(String(crAmount), '6.00000000');
                assert.strictEqual(crAddr, FEE_PAYER);
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled, 'expiry never pays validators');
            });

            it('expiry of a feeless request writes no ledger rows (baseline preserved)', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
                const data = v2FeeData();
                await handler.parse(['2', REQ_ID], data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
                assert.ok(indexer.indexerDb.createCredit.notCalled);
            });
        });
    });
});

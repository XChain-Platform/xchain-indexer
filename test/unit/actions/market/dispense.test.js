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
// The DISPENSE unit suite. This file holds how much a dispense settles for and
// whether it is valid at all; auto-close, the allow and block lists, FIAT and
// oracle pricing and the settlement records are in the parts under dispense.test/,
// and the shared fixtures in dispense.test/helpers/dispense_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { makeDispenserInfo, OWNER_ADDR, BUYER_ADDR, BLOCK_TIME, freshDispenseSuite } = require('./dispense.test/helpers/dispense_suite.js');

// ─── Test suite ───────────────────────────────────────────────────────────────

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, dispense;
function freshSuite() {
    ({ indexer, dispense } = freshDispenseSuite());
}

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── No matching dispensers ───────────────────────────────────────────

    it('no matching dispensers: deleteActionIndex called, createDispense not called', async function () {
        indexer.indexerDb.findMatchingDispensers.resolves([]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.deleteActionIndex);
        sinon.assert.notCalled(indexer.indexerDb.createDispense);
    });

    // ─── Valid dispense ───────────────────────────────────────────────────

    it('valid dispense: createDispense called with status valid', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01', // exactly 1x GET_AMOUNT → multiplier=1 → give_amount=1
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createDispense);
        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(dispenseRecord['STATUS'], 'valid');
    });

    it('give_amount calculated from multiplier (2x payment)', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.02', // 2x GET_AMOUNT → multiplier=2 → give_amount=2
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        // give_amount = 2 * 1 (GIVE_AMOUNT) = 2
        assert.ok(String(dispenseRecord['GIVE_AMOUNT']) === '2' ||
                  parseFloat(dispenseRecord['GIVE_AMOUNT']) === 2,
                  `Expected give_amount 2, got ${dispenseRecord['GIVE_AMOUNT']}`);
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    it('multiplier capped so give_amount does not exceed GIVE_REMAINING', async function () {
        // GIVE_REMAINING is 3; payment is 0.05 (5x), but can only dispense 3
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_REMAINING: '3' }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.05',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        // give_amount should be <= GIVE_REMAINING
        assert.ok(parseFloat(dispenseRecord['GIVE_AMOUNT']) <= 3,
            `give_amount ${dispenseRecord['GIVE_AMOUNT']} exceeds GIVE_REMAINING 3`);
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // The give-remaining walk (multiplier--, one bignumber multiply per
    // iteration) is now a closed-form clamp to min(multiplier, floor(GIVE_REMAINING
    // GIVE_AMOUNT)). These pin the identity of the rewrite on the edges that a
    // loop and a division disagree on, plus the DoS the loop enabled.
    it('clamp: lands exactly on capacity, not merely under it', async function () {
        // Payment covers 5 units, only 3 in escrow: the loop stopped at 3, so the
        // clamp must too. Asserted exactly rather than <= 3, which a broken clamp
        // returning 0 or 1 would also satisfy.
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_REMAINING: '3' }));
        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.05', BLOCK_TIME });

        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid');
        assert.strictEqual(String(rec['GIVE_AMOUNT']), '3');
    });

    it('clamp: floors a fractional capacity', async function () {
        // GIVE_AMOUNT 2 with 5 remaining: capacity is floor(5/2) = 2, giving 4.
        // A clamp that forgot to floor would try 2.5 units and overspend escrow.
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_AMOUNT: '2', GIVE_REMAINING: '5',
        }));
        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.05', BLOCK_TIME });

        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid');
        assert.strictEqual(String(rec['GIVE_AMOUNT']), '4');
    });

    it('clamp: skipped for a balance dispenser with no GIVE_AMOUNT', async function () {
        // The case the guard actually covers: a BALANCE dispenser opened with an empty
        // GIVE_AMOUNT, which a format-0 create still accepts below
        // dispenser_give_amount_activation. bcmul() coerced that to 0, so
        // `0 > GIVE_REMAINING` was false and the loop never ran; the clamp must skip
        // rather than divide by zero.
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_AMOUNT: null, GIVE_REMAINING: '10',
        }));
        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });

        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid', 'the legacy verdict must be left in place');
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // getDispenserInfo is the only source of `dispenser` in this handler and it
    // virtualizes an ownership dispenser to GIVE_AMOUNT '1' / GIVE_ESCROW '1', with
    // GIVE_REMAINING '1' before a dispense and '0' once one is recorded. So the clamp
    // is NOT skipped for one, and these two pin it on the fixture the hub can really
    // return rather than on the wire-level empty GIVE_AMOUNT it never emits.
    it('clamp: runs for an ownership dispenser and still settles the first fill', async function () {
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_OWNERSHIP: 1, GIVE_AMOUNT: '1', GIVE_ESCROW: '1', GIVE_REMAINING: '1',
        }));
        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });

        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid', 'ownership dispense must still settle');
        sinon.assert.called(indexer.indexerDb.clearTokenEscrow);
    });

    it('clamp alone refuses a second ownership dispense (single-shot backstop)', async function () {
        // GIVE_REMAINING '0' is what getDispenserInfo returns once a valid DISPENSE has
        // been recorded. The single-fill cap above cannot refuse anything, so the clamp
        // is the only thing between this and a second ownership transfer: it drives the
        // multiplier to 0 and the insufficient-funds check refuses. Do not delete this
        // as redundant with the DISPENSER_CLOSE auto-close; it is the backstop for the
        // auto-close failing to fire.
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_OWNERSHIP: 1, GIVE_AMOUNT: '1', GIVE_ESCROW: '1', GIVE_REMAINING: '0',
        }));
        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });

        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(String(rec['STATUS']).startsWith('invalid: insufficient funds'),
            `expected the clamp to refuse a dispensed ownership dispenser, got ${rec['STATUS']}`);
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    it('a saturated FIAT unit count settles promptly instead of spinning', async function () {
        // The DoS: a FIAT multiplier is bounded by an externally-chosen price, not
        // by GET_AMOUNT. At MAX_SAFE_INTEGER units the old loop would have run 9e15
        // bignumber multiplies to walk down to capacity, so the block never
        // finishes. Reaching an assertion at all is the proof it is closed; the
        // verdict must also still be capacity-correct.
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
            GIVE_AMOUNT: '1', GIVE_REMAINING: '7',
        }));
        sinon.stub(indexer.util, 'reversePriceMatch').resolves({ units: Number.MAX_SAFE_INTEGER });

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '1', BLOCK_TIME });
        const started = process.hrtime.bigint();
        await dispense.parse([], data, false);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid');
        assert.strictEqual(String(rec['GIVE_AMOUNT']), '7', 'clamped to the 7 tokens in escrow');
        assert.ok(elapsedMs < 5000, 'settled in ' + elapsedMs.toFixed(0) + 'ms, so no per-unit walk');
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Insufficient COIN_AMOUNT ─────────────────────────────────────────

    it('COIN_AMOUNT less than GET_AMOUNT returns invalid dispense', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.005', // less than GET_AMOUNT (0.01)
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid',
            `Expected invalid status, got "${dispenseRecord['STATUS']}"`);
    });

    it('multiplier of zero (insufficient funds after loop) returns invalid', async function () {
        // GIVE_REMAINING is 0 so loop reduces multiplier to 0
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_REMAINING: '0' }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid');
    });

    // ─── Self-trigger prevention ──────────────────────────────────────────

    it('SOURCE same as GET_ADDRESS returns invalid dispense', async function () {
        // Buyer IS the dispenser owner → self-trigger not allowed
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      OWNER_ADDR, // same as dispenser GET_ADDRESS
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid',
            `Expected invalid status for self-trigger, got "${dispenseRecord['STATUS']}"`);
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Dispense = require('../../../src/actions/dispense.js');

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

// Canonical dispenser fixture used across tests
function makeDispenserInfo(overrides = {}) {
    return {
        ACTION_INDEX:   10,
        SOURCE:         'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GET_ADDRESS:    'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'JDOG',
        GIVE_AMOUNT:    '1',        // dispense 1 JDOG per GET_AMOUNT unit
        GIVE_REMAINING: '10',       // 10 JDOG left in escrow
        GET_COIN:       'BTC',
        GET_TICK:       null,
        GET_AMOUNT:     '0.01',     // 0.01 BTC triggers 1 GIVE_AMOUNT
        ALLOW_LIST:     null,
        BLOCK_LIST:     null,
        DISPENSER_STATUS: 'open',
        ...overrides,
    };
}

describe('Dispense action handler @regression @tier2', function () {
    let indexer;
    let actionsCtx;
    let dispense;

    const OWNER_ADDR  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const BUYER_ADDR  = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
    const BLOCK_TIME  = 1700000000;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        dispense   = new Dispense(actionsCtx);

        // Default: findMatchingDispensers returns one dispenser action_index
        indexer.indexerDb.findMatchingDispensers.resolves([10]);

        // Default: getDispenserInfo returns the canonical dispenser
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());

        // Default: token info for GIVE and GET ticks
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any)
            .resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(undefined, sinon.match.any, sinon.match.any)
            .resolves(null);

        // Default: createActionIndex returns a new index
        indexer.indexerDb.createActionIndex.resolves(200);
    });

    afterEach(function () {
        sinon.restore();
    });

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

    it('clamp: skipped for an ownership dispenser with no GIVE_AMOUNT', async function () {
        // Ownership dispensers carry empty GIVE_AMOUNT/GIVE_ESCROW. bcmul() coerced
        // that to 0, so `0 > GIVE_REMAINING` was false and the loop never ran; the
        // clamp must skip rather than divide by zero.
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_OWNERSHIP: 1, GIVE_AMOUNT: null, GIVE_REMAINING: null,
        }));
        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });

        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid', 'ownership dispense must still settle');
        sinon.assert.called(indexer.indexerDb.clearTokenEscrow);
    });

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

    it('auto-close triggered when GIVE_REMAINING falls below GIVE_AMOUNT after dispense', async function () {
        // GIVE_REMAINING=1, GIVE_AMOUNT=1: after dispensing 1, remaining=0 < GIVE_AMOUNT=1
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '1',
        }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(actionsCtx.processAction);
        const [actionName] = actionsCtx.processAction.firstCall.args;
        assert.strictEqual(actionName, 'DISPENSER_CLOSE');
    });

    it('no auto-close when GIVE_REMAINING still >= GIVE_AMOUNT after dispense', async function () {
        // GIVE_REMAINING=10, GIVE_AMOUNT=1: after dispensing 1, remaining=9 >= 1 → no close
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '10',
        }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.notCalled(actionsCtx.processAction);
    });

    // Per-unit auto-close threshold under the DISPENSER_CLOSE_PER_UNIT gate
    it('gate active: large aggregate purchase does NOT close while a per-unit remains', async function () {
        // GIVE_REMAINING=10, per-unit GIVE_AMOUNT=1, buyer pays 0.05 (5 units).
        // After dispensing 5, remaining=5 >= per-unit 1 → must stay open.
        // (Legacy aggregate comparison would also stay open here; the decisive
        // case is the next test where remaining < aggregate but >= per-unit.)
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '10',
        }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.05',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledWith(actionsCtx.protocolChanges.isEnabled, 'DISPENSER_CLOSE_PER_UNIT', sinon.match.any);
        sinon.assert.notCalled(actionsCtx.processAction);
    });

    it('gate active: remaining below aggregate but at/above per-unit stays OPEN', async function () {
        // GIVE_REMAINING=8, per-unit=1, buyer pays 0.05 (5 units) → dispenses 5,
        // remaining=3. Legacy check (3 < 5) would close; per-unit check
        // (3 < 1 is false) keeps it open so later single-unit buyers are served.
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '8',
        }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.05',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.notCalled(actionsCtx.processAction);
    });

    it('gate active: closes when remaining falls below the per-unit price', async function () {
        // GIVE_REMAINING=5, per-unit=1, buyer pays 0.05 → dispenses 5, remaining=0
        // < per-unit 1 → close (genuinely cannot serve another unit).
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '5',
        }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.05',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(actionsCtx.processAction);
        assert.strictEqual(actionsCtx.processAction.firstCall.args[0], 'DISPENSER_CLOSE');
    });

    it('gate INACTIVE: legacy aggregate comparison closes early (byte-identical replay)', async function () {
        // Same scenario as the stays-OPEN test, but below the flag-day: the
        // legacy aggregate comparison (remaining 3 < give_amount 5) must close.
        actionsCtx.protocolChanges.isEnabled
            .withArgs('DISPENSER_CLOSE_PER_UNIT', sinon.match.any)
            .resolves(false);
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '8',
        }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.05',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(actionsCtx.processAction);
        assert.strictEqual(actionsCtx.processAction.firstCall.args[0], 'DISPENSER_CLOSE');
    });

    it('dispenser ALLOW_LIST excludes SOURCE: dispense invalid', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ ALLOW_LIST: '5' }));
        // The list does NOT include BUYER_ADDR
        indexer.indexerDb.getList.resolves([OWNER_ADDR]);

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

    it('dispenser BLOCK_LIST includes SOURCE: dispense invalid', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ BLOCK_LIST: '6' }));
        // BLOCK_LIST includes BUYER_ADDR
        indexer.indexerDb.getList.resolves([BUYER_ADDR]);

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

    it('GIVE_TOKEN ALLOW_LIST includes SOURCE: dispense valid', async function () {
        // Give token has an ALLOW_LIST that includes both BUYER and OWNER
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({
                TICK:       'JDOG',
                TICK_ID:    10,
                ALLOW_LIST: '3',
                BLOCK_LIST: null,
            }));
        // Both addresses in allow list
        indexer.indexerDb.getList.resolves([BUYER_ADDR, OWNER_ADDR]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(dispenseRecord['STATUS'], 'valid');
    });

    it('GIVE_TOKEN BLOCK_LIST includes SOURCE: dispense invalid', async function () {
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({
                TICK:       'JDOG',
                TICK_ID:    10,
                ALLOW_LIST: null,
                BLOCK_LIST: '4',
            }));
        // BUYER is on block list
        indexer.indexerDb.getList.resolves([BUYER_ADDR]);

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

    it('multiple matching dispensers: createDispense called for each', async function () {
        const dispenser2 = makeDispenserInfo({ ACTION_INDEX: 11, GET_ADDRESS: OWNER_ADDR });
        indexer.indexerDb.findMatchingDispensers.resolves([10, 11]);
        indexer.indexerDb.getDispenserInfo
            .withArgs('BTC', 10, sinon.match.any)
            .resolves(makeDispenserInfo());
        indexer.indexerDb.getDispenserInfo
            .withArgs('BTC', 11, sinon.match.any)
            .resolves(dispenser2);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        assert.ok(indexer.indexerDb.createDispense.callCount >= 2,
            `Expected createDispense called >=2, got ${indexer.indexerDb.createDispense.callCount}`);
    });

    it('valid dispense processes ledger changes and updates balances', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
    });

    it('valid dispense creates action mappings', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(indexer.mapper.createMappings);
    });

    it('ownership dispense transfers token ownership to the buyer', async function () {
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_OWNERSHIP: 1 }));

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid');
        sinon.assert.called(indexer.indexerDb.clearTokenEscrow);  // ownership transfer path
        sinon.assert.called(indexer.indexerDb.createIssue);
        sinon.assert.notCalled(indexer.indexerDb.createEscrow);   // no balance escrow move
    });

    // FIAT_DISPENSER_PRICING gate (follow-on to the give-remaining fix, operator decision 2026-07-24).
    // Genesis-active everywhere today, retrofitted while every mainnet chain held
    // zero dispensers, so it is byte-identical to the ungated code. Registered so
    // the settlement path is in the activation inventory with its siblings and so a
    // future matching correction has a height to hang off. These pin both states,
    // because an "off" branch nothing ever exercises is an unverified branch.
    describe('FIAT_DISPENSER_PRICING gate', function () {

        it('is genesis-active, so a FIAT dispenser settles normally', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
            }));
            sinon.stub(indexer.util, 'reversePriceMatch').resolves({ units: 2 });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.02', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid',
                'the gate must be on from genesis, or live FIAT dispensers stop settling');
        });

        it('below activation a FIAT dispense is rejected without consulting any price', async function () {
            // Only this gate is flipped, so the rejection cannot be attributed to
            // some other dispenser gate going off at the same time.
            actionsCtx.protocolChanges.isEnabled
                .withArgs('FIAT_DISPENSER_PRICING', sinon.match.any).resolves(false);
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
            }));
            const match = sinon.stub(indexer.util, 'reversePriceMatch').resolves({ units: 2 });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.02', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'invalid: FIAT dispenser pricing not active');
            sinon.assert.notCalled(match);
        });

        it('below activation an ORACLE_ADDRESS dispense is rejected the same way', async function () {
            actionsCtx.protocolChanges.isEnabled
                .withArgs('FIAT_DISPENSER_PRICING', sinon.match.any).resolves(false);
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                FIAT: 'JPY', FIAT_AMOUNT: null, ORACLE_ADDRESS: '1OracleAddrXXXXXXXXXXXXXXXXXXXX', GET_AMOUNT: null,
            }));
            const match = sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves({ units: 5 });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.02', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'invalid: FIAT dispenser pricing not active');
            sinon.assert.notCalled(match);
        });

        it('the gate never touches a non-FIAT dispenser', async function () {
            // A non-FIAT dispense must not consult FIAT_DISPENSER_PRICING at all, so
            // turning the gate off can never disturb the ordinary GET_AMOUNT path.
            const isEnabled = actionsCtx.protocolChanges.isEnabled;
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid');
            assert.ok(!isEnabled.getCalls().some(c => c.args[0] === 'FIAT_DISPENSER_PRICING'),
                'non-FIAT dispenses must not query the FIAT gate');
        });
    });

    // DISPENSER_ORACLE_PER_TOKEN_PRICE (XC-993, operator decision 2026-08-11).
    //
    // A PRICE v1 oracle publishes the price of one TOKEN. Below the activation
    // dispense.js used the affordable TOKEN count as the FILL multiplier and then
    // credited multiplier x GIVE_AMOUNT, so a dispenser giving N per fill sold each
    // token at 1/N of the published price. Above it the token count is divided by
    // GIVE_AMOUNT first. Both sides are pinned: a replay of a pre-activation block
    // must still credit the old amount, or historical mainnet state forks.
    //
    // Every case here uses GIVE_AMOUNT != 1 on purpose. At GIVE_AMOUNT 1 the two
    // readings coincide exactly, which is the whole reason this survived every
    // documented example and every test written before 2026-07-31.
    describe('DISPENSER_ORACLE_PER_TOKEN_PRICE gate (Mode B)', function () {

        // The measured case, LTC regtest 2026-07-31, DISPENSE 1956: oracle at
        // 1.5 USD per XCHAIN, GIVE_AMOUNT 5, a 0.37 LTC payment worth $11.10.
        // That is 7.4 tokens of affordability => 1 whole fill of 5 tokens ($7.50),
        // where the chain credited 7 fills / 35 tokens ($0.317 a token).
        const MEASURED = { units: 7, rawUnits: '7.4' };

        function modeBDispenser(overrides = {}) {
            return makeDispenserInfo({
                FIAT: 'USD', FIAT_AMOUNT: null, GET_AMOUNT: null,
                ORACLE_ADDRESS: '1OracleAddrXXXXXXXXXXXXXXXXXXXX',
                GIVE_AMOUNT: '5', GIVE_REMAINING: '100',
                ...overrides,
            });
        }

        it('at activation the published price buys one TOKEN, not one fill', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser());
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(MEASURED);

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid');
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '5',
                '7.4 affordable tokens at 5 per fill is ONE fill of 5 tokens');
        });

        it('below activation it still credits the legacy per-fill amount', async function () {
            // Only this gate is flipped, so a changed verdict cannot be attributed
            // to some other dispenser gate switching at the same time.
            actionsCtx.protocolChanges.isEnabled
                .withArgs('DISPENSER_ORACLE_PER_TOKEN_PRICE', sinon.match.any).resolves(false);
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser());
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(MEASURED);

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid');
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '35',
                'a pre-activation block must replay to the 35 XCHAIN the chain actually credited');
        });

        it('agrees with the legacy reading exactly at GIVE_AMOUNT 1', async function () {
            // The two readings coincide at 1, so the flag day must be a no-op there
            // and no live GIVE_AMOUNT-1 dispenser changes behavior on the day.
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser({ GIVE_AMOUNT: '1' }));
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(MEASURED);
            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });

            for(const enabled of [true, false]){
                indexer.indexerDb.createDispense.resetHistory();
                actionsCtx.protocolChanges.isEnabled
                    .withArgs('DISPENSER_ORACLE_PER_TOKEN_PRICE', sinon.match.any).resolves(enabled);

                await dispense.parse([], data, false);

                const rec = indexer.indexerDb.createDispense.firstCall.args[0];
                assert.strictEqual(String(rec['GIVE_AMOUNT']), '7',
                    `GIVE_AMOUNT 1 must settle identically with the gate ${enabled ? 'on' : 'off'}`);
            }
        });

        it('floors the fill count ONCE, so a sub-1 GIVE_AMOUNT is not under-credited', async function () {
            // 1.75 affordable tokens at half a token per fill is 3 fills = 1.5
            // tokens. Flooring to whole tokens first (floor(floor(1.75)/0.5)) gives
            // 2 fills = 1 token, which quietly keeps 0.5 of a token the buyer paid
            // for. Only reachable on a divisible token, which is most of them.
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser({
                GIVE_AMOUNT: '0.5', GIVE_REMAINING: '100',
            }));
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves({ units: 1, rawUnits: '1.75' });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid');
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '1.5');
        });

        it('falls back to the whole-token count when the matcher supplies no rawUnits', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser({ GIVE_AMOUNT: '2' }));
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves({ units: 7 });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '6', 'floor(7/2) = 3 fills of 2 tokens');
        });

        it('rejects a payment that does not cover one whole fill', async function () {
            // The matcher matched (the buyer can afford at least one token) but the
            // dispenser only sells in blocks of 5. Under-payment must be refused,
            // not rounded up, and the message is the existing insufficient-funds one.
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser());
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves({ units: 4, rawUnits: '4.9' });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.2', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.ok(String(rec['STATUS']).startsWith('invalid: insufficient funds'),
                `expected an insufficient-funds refusal, got ${rec['STATUS']}`);
        });

        it('does not divide by an ownership dispenser empty GIVE_AMOUNT', async function () {
            // GIVE_OWNERSHIP=1 carries empty GIVE_AMOUNT/GIVE_ESCROW: it dispenses
            // the ownership record, not a token quantity, and is capped to one fill.
            // Dividing here would be a divide-by-zero, and bcdiv's zero-divisor
            // return of 0 would refuse every such dispense as insufficient funds.
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser({
                GIVE_OWNERSHIP: 1, GIVE_AMOUNT: null, GIVE_REMAINING: null,
            }));
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(MEASURED);

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid', 'an ownership dispense must still settle');
            sinon.assert.called(indexer.indexerDb.clearTokenEscrow);
        });

        it('never touches Mode A, which prices from the validator snapshot', async function () {
            // Mode A's FIAT_AMOUNT is a separate surface with its own reading; this
            // decision moved Mode B only, so the gate must not even be consulted.
            const isEnabled = actionsCtx.protocolChanges.isEnabled;
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
                GIVE_AMOUNT: '5', GIVE_REMAINING: '100',
            }));
            sinon.stub(indexer.util, 'reversePriceMatch').resolves({ units: 7 });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '35');
            assert.ok(!isEnabled.getCalls().some(c => c.args[0] === 'DISPENSER_ORACLE_PER_TOKEN_PRICE'),
                'a Mode A dispense must not query the Mode B gate');
        });

        it('never touches a non-FIAT dispenser', async function () {
            const isEnabled = actionsCtx.protocolChanges.isEnabled;
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
            await dispense.parse([], data, false);

            assert.ok(!isEnabled.getCalls().some(c => c.args[0] === 'DISPENSER_ORACLE_PER_TOKEN_PRICE'),
                'the ordinary GET_AMOUNT path must not query the Mode B gate');
        });
    });

    it('FIAT dispenser resolves units via reversePriceMatch', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
        }));
        sinon.stub(indexer.util, 'reversePriceMatch').resolves({ units: 2 });

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.02', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid');
    });

    it('FIAT dispenser rejects when no price snapshot matches', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
        }));
        sinon.stub(indexer.util, 'reversePriceMatch').resolves(null);

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.02', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'invalid: no matching price snapshot');
    });

    it('FIAT dispenser with ORACLE_ADDRESS resolves units via reverseOraclePriceMatch', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            FIAT: 'JPY', FIAT_AMOUNT: '1000', ORACLE_ADDRESS: '1OracleAddrXXXXXXXXXXXXXXXXXXXX', GET_AMOUNT: null,
        }));
        const match = sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves({ units: 1 });

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid');

        // The matcher takes the priced-token chain (GIVE_COIN) for the oracle row
        // and the PAY coin (GET_COIN) for the validator pair. Equal today under the
        // same-chain guard, so pin the wiring rather than the values: passing
        // GIVE_COIN for both would be invisible until cross-chain dispensers land.
        const args = match.firstCall.args;
        assert.strictEqual(args[2], 'BTC', 'arg 3 is GIVE_COIN, the priced token chain');
        assert.strictEqual(args[8], 'BTC', 'arg 9 is GET_COIN, the coin the buyer pays');
    });

    it('FIAT oracle dispenser rejects when no oracle price matches', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            FIAT: 'JPY', FIAT_AMOUNT: '1000', ORACLE_ADDRESS: '1OracleAddrXXXXXXXXXXXXXXXXXXXX', GET_AMOUNT: null,
        }));
        sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(null);

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'invalid: no matching oracle price');
    });

    it('rejects a buyer absent from the GIVE-token ALLOW_LIST', async function () {
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, ALLOW_LIST: 60, BLOCK_LIST: null }));
        indexer.indexerDb.getList.callsFake(async (id) => (id === 60 ? ['1OtherOnlyXXXXXXXXXXXXXXXXXXXX'] : []));

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(String(rec['STATUS']).includes('GIVE_TOKEN allow list'));
    });

    it('rejects a buyer present on the GIVE-token BLOCK_LIST', async function () {
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: 61 }));
        indexer.indexerDb.getList.callsFake(async (id) => (id === 61 ? [BUYER_ADDR] : []));

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(String(rec['STATUS']).includes('GIVE_TOKEN block list'));
    });

    // A token-priced dispenser sets GET_TICK; the GET-token's lists then gate
    // the buyer's DESTINATION + the dispenser GET_ADDRESS.
    function tokenPricedDispenser(getTokenOverrides) {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GET_TICK: 'PAYTOK', GET_COIN: 'BTC' }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PAYTOK', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PAYTOK', TICK_ID: 20, ...getTokenOverrides }));
    }

    it('rejects a buyer absent from the GET-token ALLOW_LIST', async function () {
        tokenPricedDispenser({ ALLOW_LIST: 70, BLOCK_LIST: null });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 70 ? ['1OtherOnlyXXXXXXXXXXXXXXXXXXXX'] : []));

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(String(rec['STATUS']).includes('GET_TOKEN allow list'));
    });

    it('rejects a buyer present on the GET-token BLOCK_LIST', async function () {
        tokenPricedDispenser({ ALLOW_LIST: null, BLOCK_LIST: 71 });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 71 ? [BUYER_ADDR] : []));

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(String(rec['STATUS']).includes('GET_TOKEN block list'));
    });

    // Regression for the dead 'invalid: Dispenser unknown' branch: getDispenserInfo
    // returning falsy for a matched action_index must not throw a TypeError out of
    // the settlement loop (dispenserInfo[...] is never populated for it). See
    // AML finding uuid:78e3de16.
    it('unknown dispenser (getDispenserInfo returns false): does not throw, no dispense recorded for it', async function () {
        indexer.indexerDb.findMatchingDispensers.resolves([10]);
        indexer.indexerDb.getDispenserInfo.resolves(false);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await assert.doesNotReject(dispense.parse([], data, false));

        // No settlement occurs for an unknown dispenser: nothing pushed/created for it.
        sinon.assert.notCalled(indexer.indexerDb.createDispense);
    });

    it('unknown dispenser mixed with a valid one: valid dispenser still settles cleanly', async function () {
        const dispenser2 = makeDispenserInfo({ ACTION_INDEX: 11, GET_ADDRESS: OWNER_ADDR });
        indexer.indexerDb.findMatchingDispensers.resolves([10, 11]);
        indexer.indexerDb.getDispenserInfo
            .withArgs('BTC', 10, sinon.match.any)
            .resolves(false);
        indexer.indexerDb.getDispenserInfo
            .withArgs('BTC', 11, sinon.match.any)
            .resolves(dispenser2);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await assert.doesNotReject(dispense.parse([], data, false));

        // Only the known dispenser (11) produces a record.
        sinon.assert.calledOnce(indexer.indexerDb.createDispense);
        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['DISPENSER_ACTION_INDEX'], 11);
    });

    // ── MAX_DISPENSES cap (dispenser_caps_activation.js). The dispense that
    //    reaches the cap still executes; then the dispenser auto-closes with reason
    //    'max_dispenses_reached' and refunds remaining escrow (DISPENSER_CLOSE routes to
    //    SOURCE for an auto-close). Count is derived since the last refill. Gated on the
    //    dispenser-family cohort (mainnet block_time 1786060800, testnet/regtest genesis).
    describe('MAX_DISPENSES cap auto-close', function () {

        function capsCloseCall() {
            return actionsCtx.processAction.getCalls().find(
                c => c.args[0] === 'DISPENSER_CLOSE' && c.args[2] && c.args[2]['DISPENSER_STATUS'] === 'max_dispenses_reached');
        }

        it('reaching the cap (1000) still dispenses, then auto-closes with max_dispenses_reached', async function () {
            // Remaining (10) still covers a unit (1), so the "empty" close does NOT fire;
            // the max-dispenses close does. Count includes the just-settled dispense.
            indexer.indexerDb.getDispenserDispenseCount.resolves(1000);

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
            await dispense.parse([], data, false);

            // The 1000th dispense executed.
            sinon.assert.calledOnce(indexer.indexerDb.createDispense);
            assert.strictEqual(indexer.indexerDb.createDispense.firstCall.args[0]['STATUS'], 'valid');
            // Then the dispenser auto-closed with the cap reason.
            const close = capsCloseCall();
            assert.ok(close, 'a DISPENSER_CLOSE with max_dispenses_reached must be issued');
            assert.strictEqual(close.args[2]['DISPENSER_ACTION_INDEX'], 10);
        });

        it('below the cap (999) does NOT auto-close', async function () {
            indexer.indexerDb.getDispenserDispenseCount.resolves(999);

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
            await dispense.parse([], data, false);

            assert.ok(!capsCloseCall(), 'no max-dispenses close below the cap');
        });

        it('below the caps flag-day (mainnet block_time < 1786060800): no cap even at 1000', async function () {
            actionsCtx.config = Object.assign({}, indexer.config, { NETWORK: 'mainnet', COIN: 'BTC' });
            dispense = new Dispense(actionsCtx);
            indexer.indexerDb.getDispenserDispenseCount.resolves(1000);

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
            await dispense.parse([], data, false);

            assert.ok(!capsCloseCall(), 'below the flag-day the legacy uncapped behavior must run');
        });
    });
});

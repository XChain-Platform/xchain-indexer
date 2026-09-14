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
// DISPENSE unit suite: when a dispense auto-closes its dispenser, on an empty
// escrow, per unit, and at the MAX_DISPENSES cap. One part of dispense.test.js;
// the shared fixtures are in helpers/dispense_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { makeDispenserInfo, BUYER_ADDR, BLOCK_TIME, freshDispenseSuite } = require('./helpers/dispense_suite.js');

const Dispense = require('../../../../src/actions/dispense/index.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, actionsCtx, dispense;
function freshSuite() {
    ({ indexer, actionsCtx, dispense } = freshDispenseSuite());
}

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Auto-close when GIVE_REMAINING exhausted ────────────────────────

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
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

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
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

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
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

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

'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');

const Dispense = require('../../../../src/actions/dispense.js');

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

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OWNER  = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

function makeDispenserInfo(overrides = {}) {
    return Object.assign({
        ACTION_INDEX:     100,
        SOURCE:           OWNER,
        GIVE_TICK:        'TEST',
        GIVE_TICK_ID:     1,
        GIVE_AMOUNT:      '10',
        GIVE_REMAINING:   '100',
        GIVE_ESCROW:      '100',
        GIVE_COIN:        'BTC',
        GET_TICK:         '',
        GET_TICK_ID:      null,
        GET_AMOUNT:       '0.001',   // 0.001 BTC per dispense
        GET_ADDRESS:      OWNER,
        GET_COIN:         'BTC',
        ALLOW_LIST:       null,
        BLOCK_LIST:       null,
        DISPENSER_STATUS: 'open',
        COIN:             'BTC',
        FIAT_CODE:        null,
        FIAT_AMOUNT:      null,
    }, overrides);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('DISPENSE edge-case tests @regression @tier2', function () {

    // -----------------------------------------------------------------------
    // DSP-01: Payment exactly equal to GET_AMOUNT → multiplier=1, valid
    // -----------------------------------------------------------------------

    describe('DSP-01: Payment exactly equal to GET_AMOUNT → multiplier=1, dispense valid', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Dispense(actionsCtx);

            const dispenser = makeDispenserInfo();  // GET_AMOUNT = '0.001', GIVE_AMOUNT = '10'

            // findMatchingDispensers returns one match
            indexer.indexerDb.findMatchingDispensers.resolves([100]);
            indexer.indexerDb.getDispenserInfo.resolves(dispenser);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', DECIMALS: 0 }));
        });

        afterEach(function () { sinon.restore(); });

        it('COIN_AMOUNT = GET_AMOUNT → multiplier=1, createDispense called with valid status', async function () {
            const data = createBaseData({
                ACTION:           'DISPENSE',
                SOURCE,
                COIN_DESTINATION: OWNER,
                COIN_AMOUNT:      '0.00100000',  // exactly 0.001 BTC
                ACTION_INDEX:     1,
            });

            await handler.parse(null, data, null);

            assert.strictEqual(indexer.indexerDb.createDispense.callCount, 1,
                'expected createDispense to be called exactly once');

            const dispenseArg = indexer.indexerDb.createDispense.getCall(0).args[0];
            assert.strictEqual(dispenseArg['STATUS'], 'valid',
                'expected dispense status to be "valid"');
            // give_amount = multiplier(1) * GIVE_AMOUNT(10) = 10
            // bcmul returns a mathjs BigNumber; coerce to number for comparison
            const giveAmount = parseFloat(dispenseArg['GIVE_AMOUNT'].toString());
            assert.strictEqual(giveAmount, 10,
                'expected GIVE_AMOUNT = 10 for multiplier of 1');
        });
    });

    // -----------------------------------------------------------------------
    // DSP-02: Payment 1 satoshi below GET_AMOUNT → multiplier=0, fails
    // -----------------------------------------------------------------------

    describe('DSP-02: Payment 1 satoshi below GET_AMOUNT → insufficient funds', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Dispense(actionsCtx);

            const dispenser = makeDispenserInfo();  // GET_AMOUNT = '0.001'

            indexer.indexerDb.findMatchingDispensers.resolves([100]);
            indexer.indexerDb.getDispenserInfo.resolves(dispenser);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', DECIMALS: 0 }));
        });

        afterEach(function () { sinon.restore(); });

        it('COIN_AMOUNT = 0.00099999 (1 sat below 0.001) → dispense status invalid', async function () {
            const data = createBaseData({
                ACTION:           'DISPENSE',
                SOURCE,
                COIN_DESTINATION: OWNER,
                COIN_AMOUNT:      '0.00099999',  // 1 satoshi short
                ACTION_INDEX:     1,
            });

            await handler.parse(null, data, null);

            assert.strictEqual(indexer.indexerDb.createDispense.callCount, 1,
                'expected createDispense to still be called (invalid record is stored)');

            const dispenseArg = indexer.indexerDb.createDispense.getCall(0).args[0];
            assert.ok(
                typeof dispenseArg['STATUS'] === 'string' && dispenseArg['STATUS'].startsWith('invalid'),
                `expected invalid status, got: ${dispenseArg['STATUS']}`
            );
        });
    });

    // -----------------------------------------------------------------------
    // DSP-03: Payment for multiplier > GIVE_REMAINING → while loop reduces multiplier
    // -----------------------------------------------------------------------

    describe('DSP-03: Payment implies multiplier=10 but GIVE_REMAINING=50 caps to 5', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Dispense(actionsCtx);

            // GIVE_AMOUNT=10, GET_AMOUNT=0.001, GIVE_REMAINING=50
            // Payment of 0.01 BTC → naive multiplier = floor(0.01 / 0.001) = 10
            // give_amount = 10 * 10 = 100 > GIVE_REMAINING(50) → while loop reduces
            // Iteration 1: multiplier=9, give_amount=90 > 50 → reduce
            // ...
            // Iteration 5: multiplier=5, give_amount=50 <= 50 → stop
            const dispenser = makeDispenserInfo({ GIVE_REMAINING: '50' });

            indexer.indexerDb.findMatchingDispensers.resolves([100]);
            indexer.indexerDb.getDispenserInfo.resolves(dispenser);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', DECIMALS: 0 }));
        });

        afterEach(function () { sinon.restore(); });

        it('multiplier reduced to 5 by while loop, give_amount = 50', async function () {
            const data = createBaseData({
                ACTION:           'DISPENSE',
                SOURCE,
                COIN_DESTINATION: OWNER,
                COIN_AMOUNT:      '0.01000000',  // 0.01 BTC → raw multiplier = 10
                ACTION_INDEX:     1,
            });

            await handler.parse(null, data, null);

            assert.strictEqual(indexer.indexerDb.createDispense.callCount, 1,
                'expected createDispense to be called once');

            const dispenseArg = indexer.indexerDb.createDispense.getCall(0).args[0];
            assert.strictEqual(dispenseArg['STATUS'], 'valid',
                'expected dispense to be valid after multiplier reduction');

            // give_amount should be exactly GIVE_REMAINING (5 * 10 = 50)
            // bcmul returns a mathjs BigNumber; coerce to number for comparison
            const giveAmount = parseFloat(dispenseArg['GIVE_AMOUNT'].toString());
            assert.strictEqual(giveAmount, 50,
                `expected GIVE_AMOUNT = 50, got: ${dispenseArg['GIVE_AMOUNT']}`);
        });
    });

    // -----------------------------------------------------------------------
    // DSP-04: After dispense GIVE_REMAINING < GIVE_AMOUNT → auto-close
    // -----------------------------------------------------------------------

    describe('DSP-04: GIVE_REMAINING=15, one dispense of 10 leaves 5 < GIVE_AMOUNT(10) → auto-close', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Dispense(actionsCtx);

            // After dispensing 10, remaining = 15 - 10 = 5 < GIVE_AMOUNT(10) → close
            const dispenser = makeDispenserInfo({
                GIVE_AMOUNT:    '10',
                GIVE_REMAINING: '15',
            });

            indexer.indexerDb.findMatchingDispensers.resolves([100]);
            indexer.indexerDb.getDispenserInfo.resolves(dispenser);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', DECIMALS: 0 }));
        });

        afterEach(function () { sinon.restore(); });

        it('processAction called with DISPENSER_CLOSE after partial remaining < GIVE_AMOUNT', async function () {
            const data = createBaseData({
                ACTION:           'DISPENSE',
                SOURCE,
                COIN_DESTINATION: OWNER,
                COIN_AMOUNT:      '0.00100000',  // payment for 1 dispense
                ACTION_INDEX:     1,
            });

            await handler.parse(null, data, null);

            // Dispense itself should succeed
            const dispenseArg = indexer.indexerDb.createDispense.getCall(0).args[0];
            assert.strictEqual(dispenseArg['STATUS'], 'valid',
                'expected the dispense to be valid before closure check');

            // processAction should be called with DISPENSER_CLOSE
            assert.ok(actionsCtx.processAction.calledOnce,
                'expected processAction to be called once for DISPENSER_CLOSE');
            assert.strictEqual(actionsCtx.processAction.getCall(0).args[0], 'DISPENSER_CLOSE',
                'expected processAction first arg to be DISPENSER_CLOSE');

            // The closure data should reference the correct dispenser
            const closeData = actionsCtx.processAction.getCall(0).args[2];
            assert.strictEqual(closeData['DISPENSER_ACTION_INDEX'], 100,
                'expected DISPENSER_ACTION_INDEX = 100 in the close call');
            assert.strictEqual(closeData['DISPENSER_STATUS'], 'empty',
                'expected DISPENSER_STATUS = "empty" in the close call');
        });
    });

    // -----------------------------------------------------------------------
    // DSP-05: GIVE_REMAINING === GIVE_AMOUNT → one dispense empties, auto-close
    // -----------------------------------------------------------------------

    describe('DSP-05: GIVE_REMAINING=GIVE_AMOUNT → dispense succeeds and dispenser closes', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Dispense(actionsCtx);

            // After dispensing 10, remaining = 10 - 10 = 0 < GIVE_AMOUNT(10) → close
            const dispenser = makeDispenserInfo({
                GIVE_AMOUNT:    '10',
                GIVE_REMAINING: '10',
            });

            indexer.indexerDb.findMatchingDispensers.resolves([100]);
            indexer.indexerDb.getDispenserInfo.resolves(dispenser);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', DECIMALS: 0 }));
        });

        afterEach(function () { sinon.restore(); });

        it('single dispense drains remaining to 0, dispenser auto-closes', async function () {
            const data = createBaseData({
                ACTION:           'DISPENSE',
                SOURCE,
                COIN_DESTINATION: OWNER,
                COIN_AMOUNT:      '0.00100000',  // payment for 1 dispense
                ACTION_INDEX:     1,
            });

            await handler.parse(null, data, null);

            // The dispense must be valid
            assert.strictEqual(indexer.indexerDb.createDispense.callCount, 1,
                'expected createDispense to be called once');

            const dispenseArg = indexer.indexerDb.createDispense.getCall(0).args[0];
            assert.strictEqual(dispenseArg['STATUS'], 'valid',
                'expected dispense to be valid when GIVE_REMAINING === GIVE_AMOUNT');

            // After the dispense, remaining = 0 which is < GIVE_AMOUNT(10) → auto-close
            assert.ok(actionsCtx.processAction.calledOnce,
                'expected processAction to be called once (DISPENSER_CLOSE)');
            assert.strictEqual(actionsCtx.processAction.getCall(0).args[0], 'DISPENSER_CLOSE',
                'expected DISPENSER_CLOSE to be triggered when dispenser empties exactly');
        });
    });
});

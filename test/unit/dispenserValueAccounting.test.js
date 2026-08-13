/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/dispenserValueAccounting.test.js
 *
 * DISPENSE value accounting beyond the batch ledger (BATCH_ISSUANCE_LIMITS,
 * spec rows 18-20; sibling of batchSettlementValueLedger.test.js, which pins the
 * in-batch half).
 *
 * Row 18 - the RECORD. dispenses.GET_AMOUNT wrote data['COIN_AMOUNT'], the whole
 *   payment, into every row, so three batched sub-commands each recorded the full
 *   payment while consuming a third of it. The row must carry what the dispense was
 *   charged, and must carry exactly the figure the pool was drained by, so the
 *   record and the accounting can never disagree.
 *
 * Row 19 - the ORDINARY path. findMatchingDispensers returns every open dispenser
 *   behind the paid address and the handler loops over all of them, each pricing
 *   itself against the same untouched payment: one payment, N settlements, with no
 *   batch anywhere. A tightening, so it is gated, and below the gate the defect must
 *   still reproduce exactly (the replay case).
 *
 * Row 20 - the SEND path. util.processDispenserSends builds its own data object.
 *   It must NOT inherit the enclosing batch's value tally (a SEND's amount is its
 *   own debit, and it is denominated in the sent token, not in the transaction's
 *   coin), and the one-value-N-settlements property must hold there anyway, by
 *   construction, so a future batched SEND cannot reintroduce the defect.
 *
 * What only this suite can catch:
 *   - a recorded GET_AMOUNT that drifts from the amount actually consumed;
 *   - the multi-dispenser loop double-spending one payment outside a batch;
 *   - the non-batch tally masquerading as a batch by appearing on
 *     data['BATCH_VALUE_LEDGER'], which other readers take to mean "inside a batch";
 *   - a SEND-triggered dispense inheriting the batch tally.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const Utility  = require('../../src/utility.js');
const Dispense = require('../../src/actions/dispense.js');

const DISPENSER_ADDRESS = 'dispenserAddress11111111111';
const BUYER             = 'buyerAddress';

// What batch.js seeds, verbatim, once BATCH_ISSUANCE_LIMITS is enabled.
function seedLedger(){
    return { nativeFeeConsumed: '0', coinAmountConsumed: '0', oracleFeeConsumed: {} };
}

function makeUtil(){
    let util = new Utility();
    util.config['COIN']              = 'BTC';
    util.config['NETWORK']           = 'regtest';
    util.config['FEE_TOLERANCE_MIN'] = '0.95';
    return util;
}

// A dispenser giving 10 tokens per fill at 1 coin a fill, with escrow for exactly
// ONE fill. The one-fill cap is what makes attribution observable: each settlement
// draws exactly the fill price, never the whole payment.
function dispenserRow(extra){
    return Object.assign({
        ACTION_INDEX:   500,
        SOURCE:         'dispenserOwner',
        GET_ADDRESS:    DISPENSER_ADDRESS,
        GET_COIN:       'BTC',
        GET_TICK:       'BTC',
        GET_AMOUNT:     '1.00000000',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'TOKEN',
        GIVE_AMOUNT:    '10',
        GIVE_REMAINING: '10',
        GIVE_OWNERSHIP: 0,
        FIAT:           null,
        FIAT_AMOUNT:    null,
        ORACLE_ADDRESS: null,
        ALLOW_LIST:     null,
        BLOCK_LIST:     null
    }, extra || {});
}

/**
 * A DISPENSE venue.
 *
 * opts.dispenserIds : the action_indexes findMatchingDispensers returns. More than
 *                     one is the several-dispensers-behind-one-address shape (row 19).
 * opts.limits       : false pins BATCH_ISSUANCE_LIMITS OFF (the replay case).
 * opts.dispenser    : dispenser-row overrides applied to every id.
 */
function makeVenue(opts){
    opts = opts || {};
    let util  = makeUtil();
    let calls = { created: [], gateQueries: [] };
    // The ledger write must not depend on the balance-writing plumbing.
    util.processTransactionLedgerChanges = async () => {};
    let ids = opts.dispenserIds || [500];
    let indexerDb = {
        findMatchingDispensers:      async () => ids.slice(),
        // A FRESH row per id, so nothing but the value accounting can stop a later
        // dispenser in the loop (the persisted escrow decrement is out of scope here).
        getDispenserInfo:            async (coin, action_index) =>
                                        dispenserRow(Object.assign({ ACTION_INDEX: action_index },
                                                                   opts.dispenser || {})),
        getClosedDispenserAtAddress: async () => null,
        deleteActionIndex:           async () => {},
        createActionIndex:           async () => 42,
        getTokenInfo:                async () => null,
        getList:                     async () => [],
        createDispense:              async (d) => { calls.created.push(Object.assign({}, d)); },
        updateBalances:              async () => {},
        getDispenserDispenseCount:   async () => 0,
        getOraclePricesInTimeRange:  async () => opts.oraclePrices || [],
        getPricesInTimeRange:        async () => opts.snapshots    || []
    };
    let actions = {
        config:          util.config,
        decoderDb:       {},
        indexerDb:       indexerDb,
        util:            util,
        mapper:          { createMappings: async () => {} },
        protocolChanges: {
            isEnabled: async (name) => {
                calls.gateQueries.push(name);
                if(name === 'BATCH_ISSUANCE_LIMITS')
                    return opts.limits !== false;
                return true;
            }
        },
        processAction: async () => {}
    };
    return { dispense: new Dispense(actions), calls: calls, util: util, actions: actions };
}

function dispenseData(extra){
    return Object.assign({
        ACTION_INDEX:     1,
        BLOCK_INDEX:      100,
        BLOCK_TIME:       1000,
        TX_INDEX:         7,
        COIN:             'BTC',
        SOURCE:           BUYER,
        COIN_AMOUNT:      '3.00000000',
        COIN_DESTINATION: DISPENSER_ADDRESS
    }, extra || {});
}

function statuses(calls){
    return calls.created.map(d => d['STATUS']);
}

function getAmounts(calls){
    return calls.created.map(d => String(d['GET_AMOUNT']));
}

/* ------------------------------------------------------------------ *
 *  Row 18: the row records the ATTRIBUTED cost, not the whole payment
 * ------------------------------------------------------------------ */

describe('dispense value accounting: recorded GET_AMOUNT @regression @tier1', function () {

    it('inside a batch each sub-command records the fill it bought, not the whole payment', async function () {
        let { dispense, calls } = makeVenue();
        // 3 coin pays for three 1-coin fills across three sub-commands.
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });

        for(let i = 0; i < 3; i++)
            await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls),
            ['1.00000000', '1.00000000', '1.00000000'],
            'each row must carry the 1 coin it spent, not the 3 coin the transaction paid');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '3.00000000');
    });

    it('the recorded amounts sum to exactly what the pool was drained by', async function () {
        // The invariant that makes the record trustworthy: sum(rows) == tally.
        let { dispense, calls } = makeVenue();
        let data = dispenseData({ COIN_AMOUNT: '2.00000000', BATCH_VALUE_LEDGER: seedLedger() });
        let util = makeUtil();

        for(let i = 0; i < 2; i++)
            await dispense.parse(null, data, false);

        let sum = getAmounts(calls).reduce((acc, v) => util.bcformat(util.bcadd(acc, v, 8), 8), '0');
        assert.strictEqual(sum, data['BATCH_VALUE_LEDGER'].coinAmountConsumed);
        assert.strictEqual(sum, '2.00000000');
    });

    it('an overpaid single fill records only the fill, leaving the tip in the pool', async function () {
        // 3 coin against a dispenser that can serve one 1-coin fill: the clamp means
        // one fill was bought and 2 coin is still spendable by a sibling command.
        let { dispense, calls } = makeVenue();
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid']);
        assert.strictEqual(getAmounts(calls)[0], '1.00000000');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '1.00000000');
    });

    it('below the flag, and with no batch, the whole payment is recorded exactly as before', async function () {
        let { dispense, calls } = makeVenue({ limits: false });
        let data = dispenseData();

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid']);
        assert.strictEqual(getAmounts(calls)[0], '3.00000000',
            'the legacy record shape must replay byte-identically below the flag');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
    });

    it('an INVALID dispense attributes nothing and keeps the legacy figure', async function () {
        // Payment below one fill: nothing settles, so nothing is attributed and the row
        // still records what was paid at the failed attempt.
        let { dispense, calls } = makeVenue();
        let data = dispenseData({ COIN_AMOUNT: '0.50000000', BATCH_VALUE_LEDGER: seedLedger() });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['invalid: GET_AMOUNT (insufficient funds)']);
        assert.strictEqual(getAmounts(calls)[0], '0.50000000');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0',
            'a refused dispense consumes nothing');
    });

    it('the v0 FIAT path records its fill price too', async function () {
        // 10.00 USD a fill against a BTC/USD snapshot of 100: one fill costs 0.1 coin.
        let { dispense, calls } = makeVenue({
            dispenser: { FIAT: 'USD', FIAT_AMOUNT: '10.00', GET_AMOUNT: '0' },
            snapshots: [{ price: '100.00000000', timestamp: 990 }]
        });
        let data = dispenseData({ COIN_AMOUNT: '0.30000000', BATCH_VALUE_LEDGER: seedLedger() });

        for(let i = 0; i < 3; i++)
            await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls), ['0.10000000', '0.10000000', '0.10000000']);
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0.30000000');
    });

    it('a pricing path that returns no per-unit price attributes nothing, not a silent zero', async function () {
        // A matcher that priced units but handed back no per-unit cost would multiply out
        // to zero, and a zero written into the row reads as "this dispense was free".
        // Attribute nothing instead, and leave the legacy figure standing.
        let venue = makeVenue({ dispenser: { FIAT: 'USD', FIAT_AMOUNT: '10.00', GET_AMOUNT: '0' } });
        venue.util.reversePriceMatch = async () => ({ units: 3 });   // no btcPerToken
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });

        await venue.dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(venue.calls), ['valid']);
        assert.strictEqual(getAmounts(venue.calls)[0], '3.00000000');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0');
    });

    it('the recorded amount is a plain 8dp decimal STRING', async function () {
        let { dispense, calls } = makeVenue();
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });

        await dispense.parse(null, data, false);

        let recorded = calls.created[0]['GET_AMOUNT'];
        assert.strictEqual(typeof recorded, 'string', 'got ' + typeof recorded);
        assert.ok(/^\d+\.\d{8}$/.test(recorded), 'got ' + recorded);
    });
});

/* ------------------------------------------------------------------ *
 *  Row 19: one payment, N dispensers, OUTSIDE a batch
 * ------------------------------------------------------------------ */

describe('dispense value accounting: multi-dispenser payment outside a batch @regression @tier1', function () {

    const THREE = { dispenserIds: [500, 501, 502] };

    it('one fill\'s worth behind THREE dispensers fills exactly ONE', async function () {
        let { dispense, calls } = makeVenue(THREE);
        let data = dispenseData({ COIN_AMOUNT: '1.00000000' });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls),
            ['valid', 'invalid: GET_AMOUNT (insufficient funds)', 'invalid: GET_AMOUNT (insufficient funds)'],
            'one payment must buy one settlement, with no batch in sight');
        assert.strictEqual(getAmounts(calls)[0], '1.00000000');
    });

    it('BELOW the flag the same payment still fills all THREE (the replay case)', async function () {
        let { dispense, calls } = makeVenue(Object.assign({ limits: false }, THREE));
        let data = dispenseData({ COIN_AMOUNT: '1.00000000' });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid'],
            'the defect must reproduce exactly below the flag or historical blocks fork');
        assert.deepStrictEqual(getAmounts(calls),
            ['1.00000000', '1.00000000', '1.00000000'],
            'and the legacy row shape - the whole payment - stands below the flag');
    });

    it('THREE fills\' worth behind three dispensers fills all three', async function () {
        let { dispense, calls } = makeVenue(THREE);
        let data = dispenseData({ COIN_AMOUNT: '3.00000000' });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls),
            ['1.00000000', '1.00000000', '1.00000000']);
    });

    it('the non-batch tally never appears on data as a BATCH_VALUE_LEDGER', async function () {
        // That key's PRESENCE means "inside a batch" to batch.js, coinpay.js and
        // validateOracleFee. Fabricating one here would lie to all three.
        let { dispense } = makeVenue(THREE);
        let data = dispenseData({ COIN_AMOUNT: '1.00000000' });

        await dispense.parse(null, data, false);

        assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
        assert.ok(!Object.prototype.hasOwnProperty.call(data, 'BATCH_VALUE_LEDGER'));
    });

    it('the tally is scoped to ONE action: a second DISPENSE gets a fresh payment', async function () {
        // Outside a batch, one parse() IS one transaction. Two of them are two payments,
        // and the second must not be starved by the first.
        let { dispense, calls } = makeVenue();
        let data = dispenseData({ COIN_AMOUNT: '1.00000000' });

        await dispense.parse(null, data, false);
        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls), ['1.00000000', '1.00000000']);
    });

    it('a FEE_PROBE outside a batch opens no tally at all', async function () {
        let { dispense, calls } = makeVenue(THREE);
        let data = dispenseData({ COIN_AMOUNT: '1.00000000', FEE_PROBE: true });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid'],
            'the quote surfaces must keep reading the un-drained payment');
        assert.deepStrictEqual(getAmounts(calls),
            ['1.00000000', '1.00000000', '1.00000000'],
            'and a probe records the legacy figure, having attributed nothing');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
    });

    it('a batch ledger, when present, still wins over the local tally', async function () {
        // Inside a batch the shared pool is the one that must drain, so a second
        // sub-command sees what the first spent across ALL its dispensers.
        let { dispense, calls } = makeVenue(THREE);
        let data = dispenseData({ COIN_AMOUNT: '2.00000000', BATCH_VALUE_LEDGER: seedLedger() });

        await dispense.parse(null, data, false);
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '2.00000000',
            'two of the three dispensers were served by the two fills paid for');

        await dispense.parse(null, data, false);
        assert.deepStrictEqual(statuses(calls).slice(3),
            ['invalid: GET_AMOUNT (insufficient funds)',
             'invalid: GET_AMOUNT (insufficient funds)',
             'invalid: GET_AMOUNT (insufficient funds)'],
            'the exhausted batch pool feeds no further sub-command');
    });

    it('no dispenser matched: the gate is not even consulted', async function () {
        let { dispense, calls } = makeVenue({ dispenserIds: [] });
        let data = dispenseData();

        await dispense.parse(null, data, false);

        assert.strictEqual(calls.created.length, 0);
        assert.ok(!calls.gateQueries.includes('BATCH_ISSUANCE_LIMITS'),
            'a DISPENSE that matches nothing has no value to tally');
    });
});

/* ------------------------------------------------------------------ *
 *  Row 20: SEND-triggered dispenses carry their OWN value
 * ------------------------------------------------------------------ */

// A venue whose processAction routes DISPENSE into a real handler, so a SEND can be
// followed all the way through to the dispense rows it writes.
function makeSendVenue(opts){
    opts = opts || {};
    let venue = makeVenue(opts);
    let seen  = [];
    venue.actions.processAction = async (action, params, data) => {
        if(action !== 'DISPENSE')
            return;                       // DISPENSER_CLOSE and friends: not this test's subject
        seen.push(data);
        await venue.dispense.parse(null, data, false);
    };
    venue.seen = seen;
    return venue;
}

function sendRow(amount){
    return { source: BUYER, coin: 'BTC', tick: 'PAYTOKEN', amount: amount, destination: DISPENSER_ADDRESS };
}

function sendDb(sends){
    return { findDispenserSends: async () => sends };
}

describe('dispense value accounting: SEND-triggered dispenses @regression @tier1', function () {

    it('the DISPENSE never inherits the enclosing batch\'s value tally', async function () {
        let venue = makeSendVenue();
        let db    = sendDb([sendRow('1.00000000')]);
        let info  = { ACTION_INDEX: 1, BLOCK_INDEX: 100, BLOCK_TIME: 1000, TX_INDEX: 7,
                      BATCH_VALUE_LEDGER: seedLedger() };

        await venue.util.processDispenserSends(venue.actions, db, info);

        assert.strictEqual(venue.seen.length, 1);
        assert.strictEqual(venue.seen[0]['BATCH_VALUE_LEDGER'], undefined,
            'a SEND amount is its own debit, not a claim on the transaction coin pool');
        assert.ok(!Object.prototype.hasOwnProperty.call(venue.seen[0], 'BATCH_VALUE_LEDGER'));
        assert.strictEqual(info['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0',
            'and the batch pool is left untouched by it');
    });

    it('one SEND behind THREE dispensers still settles exactly ONE', async function () {
        // The property holds by construction: with no ledger inherited, the handler opens
        // its own tally over THIS send's amount. A batched SEND arrives the same way.
        let venue = makeSendVenue({ dispenserIds: [500, 501, 502] });
        let db    = sendDb([sendRow('1.00000000')]);
        let info  = { ACTION_INDEX: 1, BLOCK_INDEX: 100, BLOCK_TIME: 1000, TX_INDEX: 7,
                      BATCH_VALUE_LEDGER: seedLedger() };

        await venue.util.processDispenserSends(venue.actions, db, info);

        assert.deepStrictEqual(statuses(venue.calls),
            ['valid', 'invalid: GET_AMOUNT (insufficient funds)', 'invalid: GET_AMOUNT (insufficient funds)']);
        assert.strictEqual(getAmounts(venue.calls)[0], '1.00000000');
    });

    it('TWO sends in one transaction are two independent values, not one', async function () {
        // The shape the batch-cumulative rule must NOT collapse: each SEND was debited
        // separately, so each buys its own fill.
        let venue = makeSendVenue();
        let db    = sendDb([sendRow('1.00000000'), sendRow('1.00000000')]);
        let info  = { ACTION_INDEX: 1, BLOCK_INDEX: 100, BLOCK_TIME: 1000, TX_INDEX: 7,
                      BATCH_VALUE_LEDGER: seedLedger() };

        await venue.util.processDispenserSends(venue.actions, db, info);

        assert.deepStrictEqual(statuses(venue.calls), ['valid', 'valid']);
        assert.strictEqual(info['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0');
    });

    it('BELOW the flag one SEND behind three dispensers still settles all three', async function () {
        let venue = makeSendVenue({ dispenserIds: [500, 501, 502], limits: false });
        let db    = sendDb([sendRow('1.00000000')]);
        let info  = { ACTION_INDEX: 1, BLOCK_INDEX: 100, BLOCK_TIME: 1000, TX_INDEX: 7 };

        await venue.util.processDispenserSends(venue.actions, db, info);

        assert.deepStrictEqual(statuses(venue.calls), ['valid', 'valid', 'valid']);
    });
});

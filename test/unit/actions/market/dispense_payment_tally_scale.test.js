/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/actions/market/dispense_payment_tally_scale.test.js
 *
 * Token-payment dispense tally scale
 * (src/actions/dispense/dispense_payment_tally_scale_gate.js).
 *
 * A SEND-triggered dispense is priced in the SENT tick, which may carry up to
 * MAX_TOKEN_DECIMALS, while the non-batch payment tally in actions/dispense.js
 * ran at 8 dp and the bc helpers round half-up there. Two settlement failures
 * follow, and both are pinned against the exact tally:
 *
 *   OVER-ISSUANCE - a sub-satoshi charge renders as zero, the pool never
 *     drains, and every dispenser behind the paid address fills off one
 *     payment. That is the one-payment-N-settlements defect the batch-issuance
 *     tally exists to close, still open for a high-decimal tick.
 *   OVER-CHARGE - a charge just over half a satoshi rounds UP, so the payment
 *     drains faster than it is spent and a sibling dispenser the buyer paid
 *     for is refused.
 *
 * The suite also pins the rule's narrowness: a token payment whose amounts fit
 * 8 dp settles and records identically; the batch pool keeps its 8 dp scale,
 * which coinpay.js and validateOracleFee share.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const Utility   = require('../../../../src/utility.js');
const Dispense  = require('../../../../src/actions/dispense/index.js');
const activation = require('../../../../src/actions/dispense/dispense_payment_tally_scale_gate.js');

const DISPENSER_ADDRESS = 'dispenserAddress11111111111';
const BUYER             = 'buyerAddress';

const TEST_NETWORK = 'regtest';

function makeUtil(network){
    let util = new Utility();
    util.config['COIN']    = 'BTC';
    util.config['NETWORK'] = network;
    return util;
}

// A dispenser priced in PAYTOKEN, with escrow for exactly ONE fill so each
// settlement draws one fill price rather than the whole payment.
function dispenserRow(extra){
    return Object.assign({
        ACTION_INDEX:   500,
        SOURCE:         'dispenserOwner',
        GET_ADDRESS:    DISPENSER_ADDRESS,
        GET_COIN:       'BTC',
        GET_TICK:       'PAYTOKEN',
        GET_AMOUNT:     '0.000000004',
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
 * opts.network      : network configuration used by the handler.
 * opts.dispensers   : action_index -> dispenser-row overrides, in loop order.
 */
function makeVenue(opts){
    opts = opts || {};
    let util  = makeUtil(opts.network || TEST_NETWORK);
    let calls = { created: [] };
    util.processTransactionLedgerChanges = async () => {};
    let rows = opts.dispensers || { 500: {} };
    let ids  = Object.keys(rows).map(Number);
    let indexerDb = {
        findMatchingDispensers:      async () => ids.slice(),
        getDispenserInfo:            async (coin, action_index) =>
                                        dispenserRow(Object.assign({ ACTION_INDEX: action_index },
                                                                   rows[action_index])),
        getClosedDispenserAtAddress: async () => null,
        deleteActionIndex:           async () => {},
        createActionIndex:           async () => 42,
        getTokenInfo:                async () => null,
        getList:                     async () => [],
        createDispense:              async (d) => { calls.created.push(Object.assign({}, d)); },
        updateBalances:              async () => {},
        getDispenserDispenseCount:   async () => 0,
        getOraclePricesInTimeRange:  async () => [],
        getPricesInTimeRange:        async () => []
    };
    let actions = {
        config:          util.config,
        decoderDb:       {},
        indexerDb:       indexerDb,
        util:            util,
        mapper:          { createMappings: async () => {} },
        protocolChanges: { isEnabled: async () => true },
        processAction:   async () => {}
    };
    return { dispense: new Dispense(actions), calls: calls, util: util, actions: actions };
}

// A SEND-triggered DISPENSE exactly as util.processDispenserSends builds it:
// the SEND's own token amount in COIN_AMOUNT, no batch ledger, DISPENSE_TYPE SEND.
function sendDispenseData(amount, extra){
    return Object.assign({
        ACTION_INDEX:     1,
        BLOCK_INDEX:      100,
        BLOCK_TIME:       1786838400,
        TX_INDEX:         7,
        COIN:             'BTC',
        COIN_TICK:        'PAYTOKEN',
        SOURCE:           BUYER,
        COIN_AMOUNT:      amount,
        COIN_DESTINATION: DISPENSER_ADDRESS,
        DISPENSE_TYPE:    'SEND'
    }, extra || {});
}

function statuses(calls){
    return calls.created.map(d => d['STATUS']);
}

function getAmounts(calls){
    return calls.created.map(d => String(d['GET_AMOUNT']));
}

const INSUFFICIENT = 'invalid: GET_AMOUNT (insufficient funds)';

/* ------------------------------------------------------------------ *
 *  Scale selection
 * ------------------------------------------------------------------ */

describe('dispense payment tally scale: selection @regression @tier1', function () {

    it('the batch pool and a native-coin trigger keep the legacy scale', function () {
        assert.strictEqual(activation.dispenseTallyScale(true, true),
            activation.DISPENSE_TALLY_LEGACY_SCALE, 'the batch pool is shared with COINPAY');
        assert.strictEqual(activation.dispenseTallyScale(false, false),
            activation.DISPENSE_TALLY_LEGACY_SCALE, 'a coin payment is exact at 8 dp');
        assert.strictEqual(activation.dispenseTallyScale(true, false),
            activation.DISPENSE_TALLY_EXACT_SCALE);
    });

    it('the exact scale is the platform maximum token precision', function () {
        let cfg = require('../../../../src/config.js').getConfig();
        assert.strictEqual(activation.DISPENSE_TALLY_EXACT_SCALE, cfg['MAX_TOKEN_DECIMALS'],
            'a tick issued finer than the tally scale would be rounded by the tally again');
    });
});

/* ------------------------------------------------------------------ *
 *  Failure 1: a sub-satoshi charge drains nothing, so one payment
 *  settles every dispenser behind the address
 * ------------------------------------------------------------------ */

describe('dispense payment tally scale: over-issuance @regression @tier1', function () {

    // 0.00000001 PAYTOKEN against three dispensers at 0.000000004 a fill. The
    // payment covers two fills and two only.
    const THREE = { dispensers: { 500: {}, 501: {}, 502: {} } };
    const PAYMENT = '0.00000001';

    it('the same payment settles exactly the TWO fills it covers', async function () {
        let { dispense, calls } = makeVenue(THREE);

        await dispense.parse(null, sendDispenseData(PAYMENT), false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', INSUFFICIENT],
            'the third dispenser has no payment left to price against');
        assert.deepStrictEqual(getAmounts(calls),
            ['0.000000004', '0.000000004', PAYMENT],
            'each settled row carries the fill it bought; the refused row keeps the legacy figure');
    });

    it('the settled rows never sum past the payment', async function () {
        let { dispense, calls, util } = makeVenue(THREE);

        await dispense.parse(null, sendDispenseData(PAYMENT), false);

        let charged = calls.created
            .filter(d => d['STATUS'] === 'valid')
            .reduce((acc, d) => util.bcstr(util.bcadd(acc, d['GET_AMOUNT'], 18)), '0');
        assert.strictEqual(charged, '0.000000008');
        assert.strictEqual(util.bcgt(charged, PAYMENT), false,
            'value conservation: a dispense may never be paid for with value that was not sent');
    });
});

/* ------------------------------------------------------------------ *
 *  Failure 2: a charge over half a satoshi rounds UP, refusing a fill
 *  the buyer paid for
 * ------------------------------------------------------------------ */

describe('dispense payment tally scale: over-charge @regression @tier1', function () {

    // 0.00000001 PAYTOKEN buys one 0.000000006 fill and one 0.000000004 fill,
    // exactly, with nothing left over.
    const TWO = { dispensers: { 500: { GET_AMOUNT: '0.000000006' }, 501: { GET_AMOUNT: '0.000000004' } } };
    const PAYMENT = '0.00000001';

    it('both fills the payment covers settle', async function () {
        let { dispense, calls } = makeVenue(TWO);

        await dispense.parse(null, sendDispenseData(PAYMENT), false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls), ['0.000000006', '0.000000004'],
            'the buyer is charged what each fill costs, and the payment is exactly spent');
    });
});

/* ------------------------------------------------------------------ *
 *  Exact tally behavior for 8 dp amounts
 * ------------------------------------------------------------------ */

describe('dispense payment tally scale: unaffected settlements @regression @tier1', function () {

    // 3 PAYTOKEN against three dispensers at 1 a fill: every amount is exact at
    // 8 dp, so the wide tally is a no-op on it by value AND by recorded bytes.
    const THREE_WHOLE = {
        dispensers: {
            500: { GET_AMOUNT: '1.00000000' },
            501: { GET_AMOUNT: '1.00000000' },
            502: { GET_AMOUNT: '1.00000000' }
        }
    };

    it('a token payment that fits 8 dp settles and records without widening', async function () {
        let { dispense, calls } = makeVenue(THREE_WHOLE);

        await dispense.parse(null, sendDispenseData('3.00000000'), false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls),
            ['1.00000000', '1.00000000', '1.00000000']);
    });

    it('a native-coin trigger retains the legacy scale', async function () {
        // No DISPENSE_TYPE: the coin-paid path, whose payment and price are both
        // coin amounts the 8 dp tally already holds exactly.
        let coinData = sendDispenseData('3.00000000');
        delete coinData['DISPENSE_TYPE'];
        delete coinData['COIN_TICK'];
        let { dispense, calls } = makeVenue(THREE_WHOLE);

        await dispense.parse(null, coinData, false);

        assert.deepStrictEqual(getAmounts(calls),
            ['1.00000000', '1.00000000', '1.00000000']);
        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
    });

    it('the batch pool keeps the 8 dp scale it shares with COINPAY', async function () {
        // A batch ledger present on the data means the shared transaction pool, whose
        // string form three other readers format at 8 dp.
        let { dispense } = makeVenue({ dispensers: { 500: { GET_AMOUNT: '1.00000000' } } });
        let data = sendDispenseData('3.00000000', {
            BATCH_VALUE_LEDGER: { nativeFeeConsumed: '0', coinAmountConsumed: '0', oracleFeeConsumed: {} }
        });

        await dispense.parse(null, data, false);

        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '1.00000000',
            'the shared pool must keep its 8 dp string form');
    });
});

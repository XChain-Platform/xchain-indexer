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
 * test/unit/actions/dispense-payment-tally-scale.test.js
 *
 * Token-payment dispense tally scale flag-day
 * (dispense_payment_tally_scale_activation.js).
 *
 * A SEND-triggered dispense is priced in the SENT tick, which may carry up to
 * MAX_TOKEN_DECIMALS, while the non-batch payment tally in actions/dispense.js
 * ran at 8 dp and the bc helpers round half-up there. Two settlement failures
 * follow, and both are pinned below with the flag OFF (the replay case) and ON:
 *
 *   OVER-ISSUANCE - a sub-satoshi charge renders as zero, the pool never
 *     drains, and every dispenser behind the paid address fills off one
 *     payment. That is the one-payment-N-settlements defect the batch-issuance
 *     tally exists to close, still open for a high-decimal tick.
 *   OVER-CHARGE - a charge just over half a satoshi rounds UP, so the payment
 *     drains faster than it is spent and a sibling dispenser the buyer paid
 *     for is refused.
 *
 * The suite also pins the flag day's narrowness: a token payment whose amounts
 * fit 8 dp settles and RECORDS identically on both sides of the gate, so only
 * the amounts the defect misprices move; the batch pool keeps its 8 dp scale,
 * which coinpay.js and validateOracleFee share; and mainnet is armed at genesis
 * by the 2026-09-09 ruling.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const Utility   = require('../../../src/utility.js');
const Dispense  = require('../../../src/actions/dispense.js');
const activation = require('../../../src/dispense_payment_tally_scale_activation.js');

const DISPENSER_ADDRESS = 'dispenserAddress11111111111';
const BUYER             = 'buyerAddress';

// Regtest is armed at genesis. Mainnet is armed at genesis too since the
// 2026-09-09 ruling, so 'mainnet' alone no longer names the pre-flag-day arm; a
// below-flag venue is a mainnet venue with THIS gate's key pinned inert for the
// duration of the call (belowFlag). Pinning only this key is deliberate: the
// venue keeps every other mainnet gate the dispense path reads, dispenser_caps
// above all, at the value the live chain runs, so the legacy arm being compared
// against is the real one.
const ARMED_NETWORK   = 'regtest';
const UNARMED_NETWORK = 'mainnet';
const HOUSE_SENTINEL  = 9999999999;

async function belowFlag(fn){
    let map   = activation.DISPENSE_PAYMENT_TALLY_SCALE_ACTIVATION;
    let saved = map.mainnet;
    map.mainnet = HOUSE_SENTINEL;
    try { return await fn(); }
    finally { map.mainnet = saved; }
}

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
 * opts.network      : which side of the flag day the handler reads.
 * opts.dispensers   : action_index -> dispenser-row overrides, in loop order.
 */
function makeVenue(opts){
    opts = opts || {};
    let util  = makeUtil(opts.network || ARMED_NETWORK);
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
 *  The activation map itself
 * ------------------------------------------------------------------ */

describe('dispense payment tally scale: activation @regression @tier1', function () {

    it('mainnet is ARMED AT GENESIS by the 2026-09-09 ruling', function () {
        // 0 dispensers and 0 dispenses on mainnet (measured 2026-09-09), so no
        // token-triggered dispense ever settled under the 8 dp tally there and the
        // exact tally is identity over the indexed history.
        assert.strictEqual(activation.DISPENSE_PAYMENT_TALLY_SCALE_ACTIVATION.mainnet, 0);
        // Either sentinel reads back as "still unarmed" at the GoLiveGate.
        assert.notStrictEqual(activation.DISPENSE_PAYMENT_TALLY_SCALE_ACTIVATION.mainnet, 9999999999);
        assert.notStrictEqual(activation.DISPENSE_PAYMENT_TALLY_SCALE_ACTIVATION.mainnet, 999999999);
        assert.strictEqual(
            activation.isDispensePaymentTallyScaleActive(0, 'mainnet'), true);
        assert.strictEqual(
            activation.isDispensePaymentTallyScaleActive(1786838400, 'mainnet'), true,
            'a block after the batch-issuance arming reads the exact scale');
        assert.strictEqual(
            activation.dispenseTallyScale(1786838400, 'mainnet', true, false),
            activation.DISPENSE_TALLY_EXACT_SCALE,
            'and a token-denominated non-batch tally on mainnet is kept at the exact scale');
    });

    it('testnet and regtest run from genesis', function () {
        assert.strictEqual(activation.isDispensePaymentTallyScaleActive(0, 'testnet'), true);
        assert.strictEqual(activation.isDispensePaymentTallyScaleActive(0, 'regtest'), true);
    });

    it('an unknown network or an unparseable time stays on the legacy scale', function () {
        assert.strictEqual(activation.isDispensePaymentTallyScaleActive(0, 'nosuchnet'), false);
        assert.strictEqual(activation.isDispensePaymentTallyScaleActive(undefined, 'regtest'), false);
        assert.strictEqual(activation.dispenseTallyScale(undefined, 'regtest', true, false),
            activation.DISPENSE_TALLY_LEGACY_SCALE);
    });

    it('the batch pool and a native-coin trigger keep the legacy scale even when armed', function () {
        assert.strictEqual(activation.dispenseTallyScale(0, 'regtest', true, true),
            activation.DISPENSE_TALLY_LEGACY_SCALE, 'the batch pool is shared with COINPAY');
        assert.strictEqual(activation.dispenseTallyScale(0, 'regtest', false, false),
            activation.DISPENSE_TALLY_LEGACY_SCALE, 'a coin payment is exact at 8 dp');
        assert.strictEqual(activation.dispenseTallyScale(0, 'regtest', true, false),
            activation.DISPENSE_TALLY_EXACT_SCALE);
    });

    it('the exact scale is the platform maximum token precision', function () {
        let cfg = require('../../../src/config.js').getConfig();
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

    it('BELOW the flag one payment settles all THREE (the replay case)', async function () {
        let { dispense, calls } = makeVenue(Object.assign({ network: UNARMED_NETWORK }, THREE));

        await belowFlag(() => dispense.parse(null, sendDispenseData(PAYMENT), false));

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid'],
            'the defect must reproduce exactly below the flag or historical blocks fork');
        assert.deepStrictEqual(getAmounts(calls),
            ['0.00000000', '0.00000000', '0.00000000'],
            'and each row records the false zero the 8 dp render writes');
    });

    it('ABOVE the flag the same payment settles exactly the TWO fills it covers', async function () {
        let { dispense, calls } = makeVenue(Object.assign({ network: ARMED_NETWORK }, THREE));

        await dispense.parse(null, sendDispenseData(PAYMENT), false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', INSUFFICIENT],
            'the third dispenser has no payment left to price against');
        assert.deepStrictEqual(getAmounts(calls),
            ['0.000000004', '0.000000004', PAYMENT],
            'each settled row carries the fill it bought; the refused row keeps the legacy figure');
    });

    it('ABOVE the flag the settled rows never sum past the payment', async function () {
        let { dispense, calls, util } = makeVenue(Object.assign({ network: ARMED_NETWORK }, THREE));

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

    it('BELOW the flag the first fill drains the whole payment and the second is refused', async function () {
        let { dispense, calls } = makeVenue(Object.assign({ network: UNARMED_NETWORK }, TWO));

        await belowFlag(() => dispense.parse(null, sendDispenseData(PAYMENT), false));

        assert.deepStrictEqual(statuses(calls), ['valid', INSUFFICIENT],
            'the 8 dp render rounds a 0.000000006 charge up to a full satoshi');
        assert.deepStrictEqual(getAmounts(calls), ['0.00000001', PAYMENT]);
    });

    it('ABOVE the flag both fills the payment covers settle', async function () {
        let { dispense, calls } = makeVenue(Object.assign({ network: ARMED_NETWORK }, TWO));

        await dispense.parse(null, sendDispenseData(PAYMENT), false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls), ['0.000000006', '0.000000004'],
            'the buyer is charged what each fill costs, and the payment is exactly spent');
    });
});

/* ------------------------------------------------------------------ *
 *  The flag day is narrow: 8 dp amounts do not move at all
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

    it('a token payment that fits 8 dp settles and records identically on both sides', async function () {
        let below = makeVenue(Object.assign({ network: UNARMED_NETWORK }, THREE_WHOLE));
        let above = makeVenue(Object.assign({ network: ARMED_NETWORK },   THREE_WHOLE));

        await belowFlag(() => below.dispense.parse(null, sendDispenseData('3.00000000'), false));
        await above.dispense.parse(null, sendDispenseData('3.00000000'), false);

        assert.deepStrictEqual(statuses(above.calls), ['valid', 'valid', 'valid']);
        assert.deepStrictEqual(statuses(above.calls), statuses(below.calls));
        assert.deepStrictEqual(getAmounts(above.calls), getAmounts(below.calls),
            'the rows must be byte-identical, not merely value-equal');
        assert.deepStrictEqual(getAmounts(above.calls),
            ['1.00000000', '1.00000000', '1.00000000']);
    });

    it('a native-coin trigger is untouched by the gate', async function () {
        // No DISPENSE_TYPE: the coin-paid path, whose payment and price are both
        // coin amounts the 8 dp tally already holds exactly.
        let coinData = sendDispenseData('3.00000000');
        delete coinData['DISPENSE_TYPE'];
        delete coinData['COIN_TICK'];
        let below = makeVenue(Object.assign({ network: UNARMED_NETWORK }, THREE_WHOLE));
        let above = makeVenue(Object.assign({ network: ARMED_NETWORK },   THREE_WHOLE));

        await belowFlag(() => below.dispense.parse(null, coinData, false));
        await above.dispense.parse(null, coinData, false);

        assert.deepStrictEqual(getAmounts(above.calls), getAmounts(below.calls));
        assert.deepStrictEqual(statuses(above.calls), ['valid', 'valid', 'valid']);
    });

    it('the batch pool keeps the 8 dp scale it shares with COINPAY', async function () {
        // A batch ledger present on the data means the shared transaction pool, whose
        // string form three other readers format at 8 dp.
        let { dispense } = makeVenue({ network: ARMED_NETWORK,
                                       dispensers: { 500: { GET_AMOUNT: '1.00000000' } } });
        let data = sendDispenseData('3.00000000', {
            BATCH_VALUE_LEDGER: { nativeFeeConsumed: '0', coinAmountConsumed: '0', oracleFeeConsumed: {} }
        });

        await dispense.parse(null, data, false);

        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '1.00000000',
            'the shared pool must keep its 8 dp string form');
    });
});

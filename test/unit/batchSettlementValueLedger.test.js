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
 * test/unit/batchSettlementValueLedger.test.js
 *
 * Batch-cumulative SETTLEMENT-VALUE and ORACLE-FEE accounting against the shared
 * data['BATCH_VALUE_LEDGER'] (BATCH_ISSUANCE_LIMITS, R5b; sibling of the
 * native-fee half covered by nativeFeeBatchLedger.test.js).
 *
 * Three call sites share one defect shape: COIN_AMOUNT and TX_OUTPUTS are
 * TRANSACTION-level state that the batch loop preserves across every sub-command and
 * nothing decrements, so each sub-command judged the SAME untouched value from zero.
 *   - actions/coinpay.js  : N COINPAYs settled N obligations out of ONE payment;
 *   - actions/dispense.js : N DISPENSEs each bought a full multiplier off ONE payment;
 *   - utility.js validateOracleFee : N Mode B DISPENSER opens/refills referencing one
 *     oracle each paid ONE oracle fee.
 *
 * What only this suite can catch:
 *   - the pools actually DRAIN, proportionally: N units of value cover exactly N
 *     units of settlement, never N per sub-command;
 *   - the ledger's ABSENCE is the flag gate, so every non-BATCH transaction and every
 *     pre-flag-day BATCH behaves byte-identically and does not drift on re-entry;
 *   - the oracle tally is keyed BY ORACLE ADDRESS, so one exhausted oracle output
 *     cannot invalidate a sub-command paying a different oracle;
 *   - a FEE_PROBE (the read-only quote/dry-run surfaces) reads and writes NOTHING;
 *   - tallies stay decimal STRINGS at 8dp, never JS numbers, because they are shared
 *     mutable consensus state passed between handlers.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const Utility  = require('../../src/utility.js');
const Coinpay  = require('../../src/actions/coinpay.js');
const Dispense = require('../../src/actions/dispense.js');

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

/* ------------------------------------------------------------------ *
 *  COINPAY: one payment settles ONE obligation, not N
 * ------------------------------------------------------------------ */

const PAYEE = 'payeeAddress1111111111111111';

// The obligation every COINPAY test settles against: 5 coin owed, still pending,
// far from expiry. getOrderMatchOrders returns null below, which short-circuits the
// settlement plumbing right after the ledger is written - this suite pins the
// accounting, not the trade unwind (covered elsewhere).
function obligation(){
    return {
        ACTION_INDEX:   900,
        COINPAY_STATUS: 'pending_coinpay',
        PAYEE_ADDRESS:  PAYEE,
        COIN_AMOUNT:    '5.00000000',
        EXPIRATION:     9999999999
    };
}

function makeCoinpay(){
    let util = makeUtil();
    let calls = { created: [], deleted: [] };
    let indexerDb = {
        getCoinpayObligationInfo: async () => obligation(),
        deleteActionIndex:        async (idx) => { calls.deleted.push(idx); },
        createCoinpay:            async (row) => { calls.created.push(Object.assign({}, row)); },
        getOrderMatchOrders:      async () => null
    };
    let actions = {
        config:    util.config,
        decoderDb: {},
        indexerDb: indexerDb,
        util:      util,
        mapper:    { createMappings: async () => {} }
    };
    return { coinpay: new Coinpay(actions), calls: calls };
}

// One COINPAY sub-command's transaction context. The batch loop reuses ONE data
// object across sub-commands, so these tests do too.
function coinpayData(extra){
    return Object.assign({
        FORMAT:           0,
        ACTION_INDEX:     1,
        BLOCK_INDEX:      100,
        BLOCK_TIME:       1000,
        TX_HASH:          'txhash',
        TX_VOUT:          0,
        COIN_AMOUNT:      '5.00000000',
        COIN_DESTINATION: PAYEE
    }, extra || {});
}

describe('batch settlement value ledger: COINPAY @regression @tier1', function () {

    it('with NO ledger settles every time, byte-identically, and invents nothing', async function () {
        let { coinpay, calls } = makeCoinpay();
        let data = coinpayData();

        await coinpay.parse(['0', '900'], data, false);
        await coinpay.parse(['0', '900'], data, false);

        assert.strictEqual(calls.created.length, 2, 'both settle off the batch path');
        assert.strictEqual(calls.created[0].STATUS, 'valid');
        assert.deepStrictEqual(calls.created[1], calls.created[0], 'no drift on re-entry');
        assert.strictEqual(calls.deleted.length, 0, 'nothing skipped');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
    });

    it('ONE obligation\'s worth of payment settles exactly ONE of three sub-commands', async function () {
        let { coinpay, calls } = makeCoinpay();
        let data = coinpayData({ BATCH_VALUE_LEDGER: seedLedger() });   // pays 5, owes 5

        for(let i = 0; i < 3; i++)
            await coinpay.parse(['0', '900'], data, false);

        assert.strictEqual(calls.created.length, 1, 'only the first sub-command may settle');
        assert.strictEqual(calls.created[0].STATUS, 'valid');
        // The later two take the existing short-payment path: skip + drop the index.
        assert.strictEqual(calls.deleted.length, 2);
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '5.00000000');
    });

    it('THREE obligations\' worth settles all three and a FOURTH is refused', async function () {
        let { coinpay, calls } = makeCoinpay();
        let data = coinpayData({ COIN_AMOUNT: '15.00000000', BATCH_VALUE_LEDGER: seedLedger() });

        for(let i = 0; i < 3; i++)
            await coinpay.parse(['0', '900'], data, false);

        assert.strictEqual(calls.created.length, 3, 'three obligations, three settlements');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '15.00000000');

        await coinpay.parse(['0', '900'], data, false);
        assert.strictEqual(calls.created.length, 3, 'the exhausted payment settles nothing more');
        assert.strictEqual(calls.deleted.length, 1);
        // A refused sub-command consumes nothing.
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '15.00000000');
        // The other rows' fields are untouched by this handler.
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, '0');
    });

    it('a FEE_PROBE dry run settles and consumes nothing from the pool', async function () {
        let { coinpay, calls } = makeCoinpay();
        let data = coinpayData({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

        for(let i = 0; i < 3; i++)
            await coinpay.parse(['0', '900'], data, false);

        assert.strictEqual(calls.created.length, 3, 'a probe sees the un-drained payment');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0',
            'a read-only surface must never mutate consensus state');
    });

    it('the tally holds a decimal STRING at 8dp, never a JS number', async function () {
        let { coinpay } = makeCoinpay();
        let data = coinpayData({ COIN_AMOUNT: '15.00000000', BATCH_VALUE_LEDGER: seedLedger() });

        for(let i = 0; i < 2; i++)
            await coinpay.parse(['0', '900'], data, false);

        let consumed = data['BATCH_VALUE_LEDGER'].coinAmountConsumed;
        assert.strictEqual(typeof consumed, 'string', 'tally must be a string, got ' + typeof consumed);
        assert.ok(/^\d+\.\d{8}$/.test(consumed), 'tally must be plain 8dp decimal text, got ' + consumed);
        assert.strictEqual(consumed, '10.00000000');
    });
});

/* ------------------------------------------------------------------ *
 *  DISPENSE: one payment buys ONE dispense's worth of fills, not N
 * ------------------------------------------------------------------ */

const DISPENSER_ADDRESS = 'dispenserAddress11111111111';

// A dispenser giving 10 tokens per fill. GIVE_REMAINING covers exactly ONE fill, so
// each sub-command can buy at most one fill and the value it draws is the fill price:
// that is what makes "N fills' worth funds exactly N sub-commands" observable.
// getDispenserInfo re-reads a FRESH copy per sub-command (the persisted decrement is
// out of scope here), so only the value ledger can stop the second one.
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

function makeDispense(opts){
    opts = opts || {};
    let util  = makeUtil();
    let calls = { created: [] };
    // The ledger write must not depend on the balance-writing plumbing.
    util.processTransactionLedgerChanges = async () => {};
    let indexerDb = {
        findMatchingDispensers:     async () => [(opts.dispenser || dispenserRow()).ACTION_INDEX],
        getDispenserInfo:           async () => Object.assign({}, opts.dispenser || dispenserRow()),
        getClosedDispenserAtAddress: async () => null,
        deleteActionIndex:          async () => {},
        createActionIndex:          async () => 42,
        getTokenInfo:               async () => null,
        getList:                    async () => [],
        createDispense:             async (d) => { calls.created.push(Object.assign({}, d)); },
        updateBalances:             async () => {},
        getDispenserDispenseCount:  async () => 0,
        getOraclePricesInTimeRange: async () => opts.oraclePrices || [],
        getPricesInTimeRange:       async () => opts.snapshots    || []
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
    return { dispense: new Dispense(actions), calls: calls };
}

function dispenseData(extra){
    return Object.assign({
        ACTION_INDEX:     1,
        BLOCK_INDEX:      100,
        BLOCK_TIME:       1000,
        TX_INDEX:         7,
        COIN:             'BTC',
        SOURCE:           'buyerAddress',
        COIN_AMOUNT:      '3.00000000',
        COIN_DESTINATION: DISPENSER_ADDRESS
    }, extra || {});
}

// Status of each dispense record written, in order.
function statuses(calls){
    return calls.created.map(d => d['STATUS']);
}

describe('batch settlement value ledger: DISPENSE @regression @tier1', function () {

    it('with NO ledger buys the full multiplier every time, byte-identically', async function () {
        // A dispenser with capacity to spare, so nothing but the ledger could limit it.
        let { dispense, calls } = makeDispense({ dispenser: dispenserRow({ GIVE_REMAINING: '1000' }) });
        let data = dispenseData();

        await dispense.parse(null, data, false);
        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid']);
        // 3 coin at 1 coin per fill, 10 tokens a fill: 30 tokens, twice over.
        assert.strictEqual(String(calls.created[0]['GIVE_AMOUNT']), '30');
        assert.strictEqual(String(calls.created[1]['GIVE_AMOUNT']), '30', 'no drift on re-entry');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
    });

    it('ONE fill\'s worth of payment feeds exactly ONE of three sub-commands', async function () {
        let { dispense, calls } = makeDispense();
        let data = dispenseData({ COIN_AMOUNT: '1.00000000', BATCH_VALUE_LEDGER: seedLedger() });

        for(let i = 0; i < 3; i++)
            await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls),
            ['valid', 'invalid: GET_AMOUNT (insufficient funds)', 'invalid: GET_AMOUNT (insufficient funds)']);
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '1.00000000');
    });

    it('THREE fills\' worth feeds all three sub-commands, and a FOURTH is refused', async function () {
        let { dispense, calls } = makeDispense();
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });   // 3 coin, 1 per fill

        for(let i = 0; i < 3; i++)
            await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
        // Each sub-command was clamped to the dispenser's one remaining fill and drew
        // one fill's price, so the tally is exactly what the three dispenses bought.
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '3.00000000');

        await dispense.parse(null, data, false);
        assert.strictEqual(statuses(calls)[3], 'invalid: GET_AMOUNT (insufficient funds)');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '3.00000000',
            'a refused dispense consumes nothing');
    });

    it('a FEE_PROBE dry run dispenses against the un-drained payment and consumes nothing', async function () {
        let { dispense, calls } = makeDispense();
        let data = dispenseData({ COIN_AMOUNT: '1.00000000', BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

        for(let i = 0; i < 3; i++)
            await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0',
            'a read-only surface must never mutate consensus state');
    });

    it('the tally holds a decimal STRING at 8dp, never a JS number', async function () {
        let { dispense } = makeDispense();
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });

        await dispense.parse(null, data, false);

        let consumed = data['BATCH_VALUE_LEDGER'].coinAmountConsumed;
        assert.strictEqual(typeof consumed, 'string', 'tally must be a string, got ' + typeof consumed);
        assert.ok(/^\d+\.\d{8}$/.test(consumed), 'tally must be plain 8dp decimal text, got ' + consumed);
        assert.strictEqual(consumed, '1.00000000');
    });

    describe('FIAT pricing paths (they read the same payment)', function () {

        // v0 FIAT (no oracle): 10.00 USD a fill against a BTC/USD snapshot of 100,
        // so one fill costs 0.1 coin. GIVE_REMAINING caps each sub-command at one fill.
        const FIAT_V0 = {
            dispenser: dispenserRow({ FIAT: 'USD', FIAT_AMOUNT: '10.00', GET_AMOUNT: '0' }),
            snapshots: [{ price: '100.00000000', timestamp: 990 }]
        };

        // Mode B (user oracle): the oracle prices one TOKEN at 1.00 USD, the validator
        // prices the coin at 100 USD, and a fill hands out GIVE_AMOUNT (10) tokens, so a
        // fill again costs 0.1 coin.
        const FIAT_ORACLE = {
            dispenser: dispenserRow({ FIAT: 'USD', FIAT_AMOUNT: null, GET_AMOUNT: '0',
                                      ORACLE_ADDRESS: 'oracleAddress1111111111' }),
            oraclePrices: [{ price: '1.00000000', effectiveAt: 990 }],
            snapshots:    [{ price: '100.00000000', timestamp: 990 }]
        };

        it('v0 FIAT: THREE fills\' worth feeds three sub-commands, a fourth finds no affordable price', async function () {
            let { dispense, calls } = makeDispense(FIAT_V0);
            let data = dispenseData({ COIN_AMOUNT: '0.30000000', BATCH_VALUE_LEDGER: seedLedger() });

            for(let i = 0; i < 3; i++)
                await dispense.parse(null, data, false);

            assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0.30000000');

            // Exhausted, the reverse price match can no longer afford a single unit,
            // which is this path's own idiom for "not enough payment".
            await dispense.parse(null, data, false);
            assert.strictEqual(statuses(calls)[3], 'invalid: no matching price snapshot');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0.30000000');
        });

        it('v0 FIAT with NO ledger keeps buying off the same payment (unchanged legacy behavior)', async function () {
            let { dispense, calls } = makeDispense(FIAT_V0);
            let data = dispenseData({ COIN_AMOUNT: '0.30000000' });

            for(let i = 0; i < 3; i++)
                await dispense.parse(null, data, false);

            assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
        });

        it('oracle FIAT: THREE fills\' worth feeds three sub-commands, a fourth finds no affordable oracle price', async function () {
            let { dispense, calls } = makeDispense(FIAT_ORACLE);
            let data = dispenseData({ COIN_AMOUNT: '0.30000000', BATCH_VALUE_LEDGER: seedLedger() });

            for(let i = 0; i < 3; i++)
                await dispense.parse(null, data, false);

            assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0.30000000');

            await dispense.parse(null, data, false);
            assert.strictEqual(statuses(calls)[3], 'invalid: no matching oracle price');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0.30000000');
        });

        it('oracle FIAT: ONE fill\'s worth feeds exactly one sub-command', async function () {
            let { dispense, calls } = makeDispense(FIAT_ORACLE);
            let data = dispenseData({ COIN_AMOUNT: '0.10000000', BATCH_VALUE_LEDGER: seedLedger() });

            for(let i = 0; i < 3; i++)
                await dispense.parse(null, data, false);

            assert.deepStrictEqual(statuses(calls),
                ['valid', 'invalid: no matching oracle price', 'invalid: no matching oracle price']);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0.10000000');
        });
    });
});

/* ------------------------------------------------------------------ *
 *  validateOracleFee: one oracle-fee output pays ONE open/refill, not N
 * ------------------------------------------------------------------ */

const ORACLE_A = 'oracleAddressAAAA1111111111';
const ORACLE_B = 'oracleAddressBBBB2222222222';

// oracle VALUE 1.00 fiat per token x GIVE_ESCROW 1000 = 1000 fiat of escrow, valued at
// a coin price of 100 fiat = 10 coin, times the oracle's 1% fee => 0.1 coin expected.
const ORACLE_FEE     = '0.10000000';
const ORACLE_FEE_MIN = '0.09500000';   // 0.95x tolerance

function oracleDb(feeFraction){
    return {
        getOraclePrice:       async () => ({ value: '1.00000000', fee: (feeFraction === undefined ? '0.01' : feeFraction) }),
        getPricesInTimeRange: async () => ([{ price: '100.00000000', timestamp: 990 }])
    };
}

function feeDispenser(oracleAddress){
    return {
        ORACLE_ADDRESS: oracleAddress,
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'TOKEN',
        FIAT_CODE:      'USD',
        GET_COIN:       'BTC',
        GIVE_ESCROW:    '1000'
    };
}

function oracleData(outputs, extra){
    return Object.assign({ BLOCK_TIME: 1000, BLOCK_INDEX: 100, TX_OUTPUTS: outputs }, extra || {});
}

function outputsFor(pairs){
    return pairs.map(p => ({ address: p[0], value: p[1] }));
}

describe('batch settlement value ledger: oracle fees @regression @tier1', function () {

    it('with NO ledger accepts the same output every time, byte-identically', async function () {
        let util = makeUtil(), db = oracleDb();
        let data = oracleData(outputsFor([[ORACLE_A, ORACLE_FEE]]));

        let first  = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
        let second = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);

        assert.strictEqual(first.valid, true);
        assert.strictEqual(first.expectedFee, ORACLE_FEE);
        assert.strictEqual(first.paidAmount, ORACLE_FEE);
        assert.deepStrictEqual(second, first, 'no drift on re-entry');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
    });

    it('with NO ledger still rejects an underpayment with the unchanged error shape', async function () {
        let util = makeUtil(), db = oracleDb();
        let data = oracleData(outputsFor([[ORACLE_A, '0.09499999']]));

        let r = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
        assert.strictEqual(r.valid, false);
        assert.strictEqual(r.error,
            'invalid: ORACLE_ADDRESS (insufficient oracle fee, paid 0.09499999, expected ' + ORACLE_FEE + ')');
    });

    it('ONE fee\'s worth of output pays exactly ONE of three sub-commands', async function () {
        let util = makeUtil(), db = oracleDb();
        let data = oracleData(outputsFor([[ORACLE_A, ORACLE_FEE]]), { BATCH_VALUE_LEDGER: seedLedger() });

        let results = [];
        for(let i = 0; i < 3; i++)
            results.push(await util.validateOracleFee(data, feeDispenser(ORACLE_A), db));

        assert.strictEqual(results[0].valid, true);
        assert.strictEqual(results[1].valid, false, 'the second open must not reuse the same output');
        assert.strictEqual(results[2].valid, false);
        assert.strictEqual(results[1].error,
            'invalid: ORACLE_ADDRESS (insufficient oracle fee, paid 0.00000000, expected ' + ORACLE_FEE + ')');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].oracleFeeConsumed[ORACLE_A], ORACLE_FEE);
    });

    it('THREE fees\' worth pays all three, and a FOURTH is refused', async function () {
        let util = makeUtil(), db = oracleDb();
        let data = oracleData(outputsFor([[ORACLE_A, '0.30000000']]), { BATCH_VALUE_LEDGER: seedLedger() });

        for(let i = 0; i < 3; i++){
            let r = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
            assert.strictEqual(r.valid, true, 'open ' + i + ' must be paid for');
            // Each command is attributed ONE expected fee, never the whole output.
            assert.strictEqual(r.paidAmount, ORACLE_FEE, 'open ' + i + ' attribution');
        }
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].oracleFeeConsumed[ORACLE_A], '0.30000000');

        let fourth = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
        assert.strictEqual(fourth.valid, false);
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].oracleFeeConsumed[ORACLE_A], '0.30000000',
            'a refused open consumes nothing');
    });

    it('the 0.95x tolerance does not compound: paying exactly the minimum buys ONE open', async function () {
        let util = makeUtil(), db = oracleDb();
        let data = oracleData(outputsFor([[ORACLE_A, ORACLE_FEE_MIN]]), { BATCH_VALUE_LEDGER: seedLedger() });

        let first = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
        assert.strictEqual(first.valid, true, 'exactly minAcceptable is still a valid fee');
        // Drained at what is actually available, below the expected fee but never above it.
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].oracleFeeConsumed[ORACLE_A], ORACLE_FEE_MIN);

        let second = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
        assert.strictEqual(second.valid, false, 'a 0.95x payment must never cover a second open');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].oracleFeeConsumed[ORACLE_A], ORACLE_FEE_MIN);
    });

    it('TWO oracles in one batch keep independent tallies', async function () {
        let util = makeUtil(), db = oracleDb();
        let data = oracleData(outputsFor([[ORACLE_A, ORACLE_FEE], [ORACLE_B, '0.20000000']]),
                              { BATCH_VALUE_LEDGER: seedLedger() });

        let a1 = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
        let a2 = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
        let b1 = await util.validateOracleFee(data, feeDispenser(ORACLE_B), db);
        let b2 = await util.validateOracleFee(data, feeDispenser(ORACLE_B), db);
        let b3 = await util.validateOracleFee(data, feeDispenser(ORACLE_B), db);

        assert.strictEqual(a1.valid, true);
        assert.strictEqual(a2.valid, false, 'oracle A is exhausted after one open');
        assert.strictEqual(b1.valid, true, 'oracle B must not be blocked by exhausted oracle A');
        assert.strictEqual(b2.valid, true, 'oracle B paid for two opens');
        assert.strictEqual(b3.valid, false, 'oracle B is exhausted after two opens');

        let tally = data['BATCH_VALUE_LEDGER'].oracleFeeConsumed;
        assert.strictEqual(tally[ORACLE_A], ORACLE_FEE);
        assert.strictEqual(tally[ORACLE_B], '0.20000000');
    });

    it('a FEE_PROBE reads and writes nothing', async function () {
        let util = makeUtil(), db = oracleDb();
        let data = oracleData(outputsFor([[ORACLE_A, ORACLE_FEE]]),
                              { BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

        for(let i = 0; i < 5; i++){
            let r = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
            assert.strictEqual(r.valid, true, 'probe ' + i + ' must still quote valid');
            assert.strictEqual(r.paidAmount, ORACLE_FEE, 'a probe reports the full output');
            assert.deepStrictEqual(data['BATCH_VALUE_LEDGER'].oracleFeeConsumed, {},
                'the public quote path must never mutate consensus state');
        }
    });

    it('a below-dust fee (no output read) consumes nothing', async function () {
        let util = makeUtil(), db = oracleDb('0');   // zero fee fraction: nothing owed
        let data = oracleData(undefined, { BATCH_VALUE_LEDGER: seedLedger() });

        let r = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.belowDust, true);
        assert.deepStrictEqual(data['BATCH_VALUE_LEDGER'].oracleFeeConsumed, {});
    });

    it('a rejected underpayment against a fresh pool consumes nothing', async function () {
        let util = makeUtil(), db = oracleDb();
        let data = oracleData(outputsFor([[ORACLE_A, '0.01000000']]), { BATCH_VALUE_LEDGER: seedLedger() });

        let r = await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);
        assert.strictEqual(r.valid, false);
        assert.deepStrictEqual(data['BATCH_VALUE_LEDGER'].oracleFeeConsumed, {});
    });

    it('the per-oracle tally holds decimal STRINGS at 8dp, never JS numbers', async function () {
        let util = makeUtil(), db = oracleDb();
        let data = oracleData(outputsFor([[ORACLE_A, '0.30000000']]), { BATCH_VALUE_LEDGER: seedLedger() });

        for(let i = 0; i < 3; i++)
            await util.validateOracleFee(data, feeDispenser(ORACLE_A), db);

        let consumed = data['BATCH_VALUE_LEDGER'].oracleFeeConsumed[ORACLE_A];
        assert.strictEqual(typeof consumed, 'string', 'tally must be a string, got ' + typeof consumed);
        assert.ok(/^\d+\.\d{8}$/.test(consumed), 'tally must be plain 8dp decimal text, got ' + consumed);
        // The sibling rows are untouched by this validator.
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, '0');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0');
    });
});

/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 */

// test/unit/batch_settlement_value_ledger.test/dispense.test.js
//
// Covers payment-pool consumption across fixed and fiat-priced dispense sub-commands.

'use strict';

const Dispense = require('../../../src/actions/dispense/index.js');
const { assert, seedLedger, makeUtil } = require('./helpers/value_ledger.js');

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

// Mode B (user oracle): the oracle prices one TOKEN at 1.00 USD, the validator
// prices the coin at 100 USD, and a fill hands out GIVE_AMOUNT (10) tokens, so a
// fill again costs 0.1 coin.
const FIAT_ORACLE = {
    dispenser: dispenserRow({ FIAT: 'USD', FIAT_AMOUNT: null, GET_AMOUNT: '0',
                              ORACLE_ADDRESS: 'oracleAddress1111111111' }),
    oraclePrices: [{ price: '1.00000000', effectiveAt: 990 }],
    snapshots:    [{ price: '100.00000000', timestamp: 990 }]
};

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
});

describe('batch settlement value ledger: DISPENSE @regression @tier1', function () {
    it('the tally holds a decimal STRING at 8dp, never a JS number', async function () {
        let { dispense } = makeDispense();
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });

        await dispense.parse(null, data, false);

        let consumed = data['BATCH_VALUE_LEDGER'].coinAmountConsumed;
        assert.strictEqual(typeof consumed, 'string', 'tally must be a string, got ' + typeof consumed);
        assert.ok(/^\d+\.\d{8}$/.test(consumed), 'tally must be plain 8dp decimal text, got ' + consumed);
        assert.strictEqual(consumed, '1.00000000');
    });
});

describe('batch settlement value ledger: DISPENSE @regression @tier1', function () {
    describe('FIAT pricing paths (they read the same payment)', function () {
        // v0 FIAT (no oracle): 10.00 USD a fill against a BTC/USD snapshot of 100,
        // so one fill costs 0.1 coin. GIVE_REMAINING caps each sub-command at one fill.
        const FIAT_V0 = {
            dispenser: dispenserRow({ FIAT: 'USD', FIAT_AMOUNT: '10.00', GET_AMOUNT: '0' }),
            snapshots: [{ price: '100.00000000', timestamp: 990 }]
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
    });
});

describe('batch settlement value ledger: DISPENSE @regression @tier1', function () {
    describe('FIAT pricing paths (they read the same payment)', function () {
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

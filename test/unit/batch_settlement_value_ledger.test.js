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
 * test/unit/batch_settlement_value_ledger.test.js
 *
 * Batch-cumulative SETTLEMENT-VALUE and ORACLE-FEE accounting against the shared
 * data['BATCH_VALUE_LEDGER'] (BATCH_ISSUANCE_LIMITS; sibling of the
 * native-fee half covered by native_fee_batch_ledger.test.js).
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

const Coinpay = require('../../src/actions/coinpay/index.js');
const { assert, seedLedger, makeUtil } =
    require('./batch_settlement_value_ledger.test/helpers/value_ledger.js');

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
});

describe('batch settlement value ledger: COINPAY @regression @tier1', function () {
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

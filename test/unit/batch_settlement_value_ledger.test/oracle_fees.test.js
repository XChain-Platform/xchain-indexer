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

// test/unit/batch_settlement_value_ledger.test/oracle_fees.test.js
//
// Covers per-oracle fee-pool consumption and the read-only probe behavior.

'use strict';

const { assert, seedLedger, makeUtil } = require('./helpers/value_ledger.js');

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
});

describe('batch settlement value ledger: oracle fees @regression @tier1', function () {
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
});

describe('batch settlement value ledger: oracle fees @regression @tier1', function () {
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

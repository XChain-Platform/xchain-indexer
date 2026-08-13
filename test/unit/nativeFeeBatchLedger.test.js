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
 * test/unit/nativeFeeBatchLedger.test.js
 *
 * Batch-cumulative native-fee accounting inside util.validateNativeCoinFee
 * (BATCH_ISSUANCE_LIMITS, R5; the live defect it closes is XC-1455).
 *
 * TX_OUTPUTS is transaction-level state that the batch loop preserves across every
 * sub-command and nothing decrements, so each of N fee-bearing sub-commands used to
 * judge the SAME untouched fee output from zero: one ORDER's fee validated a hundred
 * ORDERs. batch.js now seeds data['BATCH_VALUE_LEDGER'] as a base key and this
 * validator tallies nativeFeeConsumed into it.
 *
 * What only this suite can catch:
 *   - the pool actually DRAINS: N commands' worth covers exactly N, never N+1, and
 *     the 0.95x per-command tolerance does not compound into a free extra command;
 *   - the ledger's ABSENCE is the flag gate, so every non-BATCH transaction and every
 *     pre-flag-day BATCH still returns the full paid amount with no drift on re-entry;
 *   - a FEE_PROBE (the PUBLIC feequote path) reads and writes NOTHING. A probe that
 *     drained the ledger would let anyone spend a real transaction's fee pool through
 *     a read-only quote API;
 *   - the ledger stays decimal STRINGS at 8dp, never JS numbers or bignumbers, because
 *     it is shared mutable consensus state passed between handlers.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const Utility = require('../../src/utility.js');

const FEE_DEST = 'feeDestinationAddr111111111111111';

// 0.5 XCHAIN @ $1.00 with DOGE @ $0.10 => expected 5.00000000 DOGE per command,
// minAcceptable 4.75000000 (0.95x). Every figure below is derived from that band.
const FEES     = { AMOUNT: '0.5' };
const EXPECTED = '5.00000000';
const MIN_ACC  = '4.75000000';

function makeUtil(){
    let util = new Utility();
    util.config['COIN']                         = 'DOGE';
    util.config['ADDRESS']                      = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: FEE_DEST });
    util.config['FEE_TOLERANCE_MIN']            = '0.95';
    util.config['FEE_TOLERANCE_MAX']            = '1.10';
    util.config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;
    return util;
}

// Minimal price oracle stub: the real getFeeOraclePrices only needs getLatestPrice.
function priceStub(){
    return {
        getLatestPrice: async (pair) => {
            let prices = { 'XCHAIN/USD': '1.00000000', 'DOGE/USD': '0.10000000' };
            if(!(pair in prices))
                return null;
            return { price: prices[pair], roundNumber: 7, block_timestamp: 1000 };
        }
    };
}

// A fresh transaction context per test; the ledger lives on it, so sharing one
// object across tests would leak consumed value between them.
function makeData(extra){
    return Object.assign({ BLOCK_INDEX: 100, BLOCK_TIME: 1000, COIN: 'DOGE' }, extra || {});
}

// What batch.js seeds, verbatim, once BATCH_ISSUANCE_LIMITS is enabled.
function seedLedger(){
    return { nativeFeeConsumed: '0', coinAmountConsumed: '0' };
}

function outputs(value){
    return [{ address: FEE_DEST, value: value }];
}

describe('native fee batch ledger @regression @tier1', function () {

    describe('no ledger (non-BATCH tx, or a pre-flag-day BATCH)', function () {

        it('returns the FULL paid amount and repeats identically on re-entry', async function () {
            let util = makeUtil(), db = priceStub(), data = makeData();
            let out  = outputs('15.00000000');

            let first  = await util.validateNativeCoinFee(data, FEES, db, out);
            let second = await util.validateNativeCoinFee(data, FEES, db, out);

            assert.strictEqual(first.valid, true);
            assert.strictEqual(first.nativeCoinAmount, '15.00000000');
            assert.strictEqual(first.expectedAmount, EXPECTED);
            // Byte-identical on the second call: nothing was consumed, nothing drifted.
            assert.deepStrictEqual(second, first);
            // And nothing was invented on the transaction context.
            assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
        });

        it('still rejects an underpaid fee with the unchanged error shape', async function () {
            let util = makeUtil(), db = priceStub(), data = makeData();
            let r = await util.validateNativeCoinFee(data, FEES, db, outputs('4.74999999'));
            assert.strictEqual(r.valid, false);
            assert.strictEqual(r.error,
                'insufficient native coin fee (paid: 4.74999999, expected: ' + EXPECTED + ', min: ' + MIN_ACC + ')');
        });
    });

    describe('batch pool accounting', function () {

        it('ONE command\'s worth of fee validates exactly ONE of three commands', async function () {
            let util = makeUtil(), db = priceStub();
            let data = makeData({ BATCH_VALUE_LEDGER: seedLedger() });
            let out  = outputs(EXPECTED);

            let results = [];
            for(let i = 0; i < 3; i++)
                results.push(await util.validateNativeCoinFee(data, FEES, db, out));

            assert.strictEqual(results[0].valid, true, 'first command must be paid for');
            assert.strictEqual(results[0].nativeCoinAmount, EXPECTED);
            assert.strictEqual(results[1].valid, false, 'second command must NOT reuse the same output');
            assert.strictEqual(results[2].valid, false, 'third command must NOT reuse the same output');
            // Pool exactly exhausted, so siblings see it as an unpaid fee output.
            assert.strictEqual(results[1].error, 'fee output has zero value');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, EXPECTED);
        });

        it('THREE commands\' worth validates all three and leaves the ledger at 3x expected', async function () {
            let util = makeUtil(), db = priceStub();
            let data = makeData({ BATCH_VALUE_LEDGER: seedLedger() });
            let out  = outputs('15.00000000');

            for(let i = 0; i < 3; i++){
                let r = await util.validateNativeCoinFee(data, FEES, db, out);
                assert.strictEqual(r.valid, true, 'command ' + i + ' must be valid');
                // Each command is attributed ONE command's fee, not the whole output.
                assert.strictEqual(r.nativeCoinAmount, EXPECTED, 'command ' + i + ' attribution');
            }

            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, '15.00000000');
            // The other row's field is untouched by this validator.
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0');
        });

        it('a FOURTH command against that exhausted pool is rejected', async function () {
            let util = makeUtil(), db = priceStub();
            let data = makeData({ BATCH_VALUE_LEDGER: seedLedger() });
            let out  = outputs('15.00000000');

            for(let i = 0; i < 3; i++)
                await util.validateNativeCoinFee(data, FEES, db, out);

            let fourth = await util.validateNativeCoinFee(data, FEES, db, out);
            assert.strictEqual(fourth.valid, false);
            assert.strictEqual(fourth.error, 'fee output has zero value');
            // A rejected command consumes nothing.
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, '15.00000000');
        });

        it('the 0.95x tolerance does not compound: paying exactly minAcceptable buys ONE command', async function () {
            let util = makeUtil(), db = priceStub();
            let data = makeData({ BATCH_VALUE_LEDGER: seedLedger() });
            let out  = outputs(MIN_ACC);

            let first = await util.validateNativeCoinFee(data, FEES, db, out);
            assert.strictEqual(first.valid, true, 'exactly minAcceptable is still a valid fee');
            assert.strictEqual(first.nativeCoinAmount, MIN_ACC);
            // Drained at what is actually available (below expectedNative), never above it.
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, MIN_ACC);

            let second = await util.validateNativeCoinFee(data, FEES, db, out);
            assert.strictEqual(second.valid, false, 'a 0.95x payment must never cover a second command');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, MIN_ACC);
        });

        it('a partly-drained pool reports the REMAINDER, not the full output, when it underpays', async function () {
            let util = makeUtil(), db = priceStub();
            let data = makeData({ BATCH_VALUE_LEDGER: seedLedger() });
            let out  = outputs('6.00000000');

            let first = await util.validateNativeCoinFee(data, FEES, db, out);
            assert.strictEqual(first.valid, true);

            let second = await util.validateNativeCoinFee(data, FEES, db, out);
            assert.strictEqual(second.valid, false);
            // 6.0 paid - 5.0 consumed = 1.0 left, which is what the message must say.
            assert.strictEqual(second.error,
                'insufficient native coin fee (paid: 1.00000000, expected: ' + EXPECTED + ', min: ' + MIN_ACC + ')');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, EXPECTED);
        });
    });

    describe('paths that must consume nothing', function () {

        it('a FEE_PROBE dry run leaves nativeFeeConsumed untouched and still quotes valid', async function () {
            let util = makeUtil(), db = priceStub();
            let data = makeData({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });
            let out  = outputs(EXPECTED);

            for(let i = 0; i < 5; i++){
                let r = await util.validateNativeCoinFee(data, FEES, db, out);
                assert.strictEqual(r.valid, true, 'probe ' + i + ' must still quote valid');
                // A probe reports the full output, exactly as it did before the ledger existed.
                assert.strictEqual(r.nativeCoinAmount, EXPECTED);
                assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, '0',
                    'the public quote API must never mutate consensus state');
            }
        });

        it('a zero-fee command (xchainAmount 0) consumes nothing from the pool', async function () {
            let util = makeUtil(), db = priceStub();
            let data = makeData({ BATCH_VALUE_LEDGER: seedLedger() });
            let out  = outputs(EXPECTED);

            let free = await util.validateNativeCoinFee(data, { AMOUNT: '0' }, db, out);
            assert.strictEqual(free.valid, true);
            assert.strictEqual(free.nativeCoinAmount, '0');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, '0');

            // The pool it did not touch is still worth a full fee-bearing command.
            let paid = await util.validateNativeCoinFee(data, FEES, db, out);
            assert.strictEqual(paid.valid, true);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, EXPECTED);
        });

        it('a rejected underpayment against a fresh pool consumes nothing', async function () {
            let util = makeUtil(), db = priceStub();
            let data = makeData({ BATCH_VALUE_LEDGER: seedLedger() });

            let r = await util.validateNativeCoinFee(data, FEES, db, outputs('1.00000000'));
            assert.strictEqual(r.valid, false);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, '0');
        });
    });

    describe('ledger value discipline', function () {

        it('holds decimal STRINGS, never JS numbers, after several accumulations', async function () {
            let util = makeUtil(), db = priceStub();
            let data = makeData({ BATCH_VALUE_LEDGER: seedLedger() });
            // A band with a non-round remainder: 0.3 XCHAIN => 3.00000000 DOGE per command.
            let fees = { AMOUNT: '0.3' };
            let out  = outputs('10.00000000');

            for(let i = 0; i < 3; i++)
                await util.validateNativeCoinFee(data, fees, db, out);

            let consumed = data['BATCH_VALUE_LEDGER'].nativeFeeConsumed;
            assert.strictEqual(typeof consumed, 'string', 'ledger must hold a string, got ' + typeof consumed);
            assert.ok(/^\d+\.\d{8}$/.test(consumed), 'ledger must be plain 8dp decimal text, got ' + consumed);
            assert.strictEqual(consumed, '9.00000000');
            // Untouched sibling field keeps its seeded string form too.
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0');
        });
    });
});

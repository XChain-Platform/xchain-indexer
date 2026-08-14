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
 * test/unit/batchedCoinpayMultiPayee.test.js
 *
 * A batched COINPAY settling ITS OWN payment output (BATCH_ISSUANCE_LIMITS,
 * spec row 25; the other half of the settlement ledger pinned by
 * batchSettlementValueLedger.test.js).
 *
 * Outside a batch, db.js getDecoderBlockData emits one row per native-coin output
 * and output_fanout.js leaves a COINPAY transaction's rows alone, so
 * COIN_DESTINATION/COIN_AMOUNT walk the whole output set. A BATCH row is not a
 * per-output settlement row, so collapseOutputFanout keeps only the LOWEST-VOUT
 * row: every sub-command saw one payee's output and N COINPAYs to N sellers
 * cleared exactly one. The fix must not restore fan-out for BATCH (that would
 * re-execute every sub-command once per output); the handler reads TX_OUTPUTS,
 * which getDecoderBlockData already attaches in full to the surviving row.
 *
 * What only this suite can catch:
 *   - N payments to N payees in one batch settle N obligations, each against its
 *     OWN output, without any fan-out;
 *   - the tally is per-ADDRESS, so one payee's exhausted output can never
 *     invalidate a sibling obligation paid separately (the failure a single
 *     scalar would have produced);
 *   - the A5 invariant still binds PER PAYEE on the new path: one payment's worth
 *     to one seller settles ONE of that seller's obligations, never two;
 *   - the shared scalar coinAmountConsumed still covers the row's own
 *     COIN_DESTINATION output, byte for byte, so actions/dispense.js keeps seeing
 *     what COINPAY spent from the pool they share;
 *   - below the flag (no ledger) the ORIGINAL one-settles-of-N defect reproduces
 *     exactly, and a non-batched COINPAY is untouched;
 *   - the settled record is filed against the output that actually paid, not
 *     against a different seller's payment.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const Utility = require('../../src/utility.js');
const Coinpay = require('../../src/actions/coinpay.js');

// What batch.js seeds, verbatim, once BATCH_ISSUANCE_LIMITS is enabled. Note there is
// no coinPayeeConsumed key: coinpay.js creates that cell lazily, so a batch that never
// pays a second payee carries exactly the object batch.js wrote.
function seedLedger(){
    return { nativeFeeConsumed: '0', coinAmountConsumed: '0', oracleFeeConsumed: {} };
}

const PAYEE_A = 'payeeAddressAAAA111111111111';
const PAYEE_B = 'payeeAddressBBBB222222222222';
const PAYEE_C = 'payeeAddressCCCC333333333333';

// Obligations, keyed by ORDER_MATCH_ACTION_INDEX. Two sellers, and two obligations
// against the SAME seller so the per-payee A5 invariant is observable.
const OBLIGATIONS = {
    900: { ACTION_INDEX: 900, COINPAY_STATUS: 'pending_coinpay', PAYEE_ADDRESS: PAYEE_A, COIN_AMOUNT: '5.00000000', EXPIRATION: 9999999999 },
    901: { ACTION_INDEX: 901, COINPAY_STATUS: 'pending_coinpay', PAYEE_ADDRESS: PAYEE_B, COIN_AMOUNT: '3.00000000', EXPIRATION: 9999999999 },
    902: { ACTION_INDEX: 902, COINPAY_STATUS: 'pending_coinpay', PAYEE_ADDRESS: PAYEE_A, COIN_AMOUNT: '5.00000000', EXPIRATION: 9999999999 },
    903: { ACTION_INDEX: 903, COINPAY_STATUS: 'pending_coinpay', PAYEE_ADDRESS: PAYEE_B, COIN_AMOUNT: '3.00000000', EXPIRATION: 9999999999 },
    904: { ACTION_INDEX: 904, COINPAY_STATUS: 'pending_coinpay', PAYEE_ADDRESS: PAYEE_C, COIN_AMOUNT: '2.00000000', EXPIRATION: 9999999999 }
};

function makeCoinpay(){
    let util = new Utility();
    util.config['COIN']    = 'BTC';
    util.config['NETWORK'] = 'regtest';

    let calls = { created: [], deleted: [] };
    let indexerDb = {
        // A FRESH copy each call: the obligation store is not what limits settlement here,
        // the payment pool is. getOrderMatchOrders returning null short-circuits the trade
        // unwind right after the ledger write, which is the surface this suite pins.
        getCoinpayObligationInfo: async (idx) => {
            let row = OBLIGATIONS[Number(idx)];
            return row ? Object.assign({}, row) : false;
        },
        deleteActionIndex: async (idx) => { calls.deleted.push(idx); },
        createCoinpay:     async (row) => { calls.created.push(Object.assign({}, row)); },
        getOrderMatchOrders: async () => null
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

// The full output set db.js getDecoderBlockData attaches to EVERY emitted row, sorted
// by vout. A pays 5 at vout 1, B pays 3 at vout 2, C pays 2 at vout 3.
function outputs(){
    return [
        { vout: 1, address: PAYEE_A, value: '5.00000000' },
        { vout: 2, address: PAYEE_B, value: '3.00000000' },
        { vout: 3, address: PAYEE_C, value: '2.00000000' }
    ];
}

// The transaction context a batched sub-command sees. collapseOutputFanout kept the
// LOWEST-VOUT row, so COIN_DESTINATION/COIN_AMOUNT/TX_VOUT describe output 1 (payee A)
// for every sub-command, whichever seller that sub-command owes.
function batchRow(extra){
    return Object.assign({
        FORMAT:           0,
        ACTION_INDEX:     1,
        BLOCK_INDEX:      100,
        BLOCK_TIME:       1000,
        TX_HASH:          'txhash',
        TX_VOUT:          1,
        COIN_AMOUNT:      '5.00000000',
        COIN_DESTINATION: PAYEE_A,
        TX_OUTPUTS:       outputs()
    }, extra || {});
}

// Run one COINPAY sub-command against `data` (the batch loop reuses ONE data object).
async function sub(coinpay, data, obligationIndex){
    await coinpay.parse(['0', String(obligationIndex)], data, false);
}

// Which obligations settled, in order.
function settled(calls){
    return calls.created.map(r => r.OBLIGATION_ACTION_INDEX);
}

describe('batched COINPAY resolves its own payment output @regression @tier1', function () {

    describe('N payments to N payees settle N obligations', function () {

        it('two sellers, each paid their own output, BOTH settle', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger() });

            await sub(coinpay, data, 900);   // payee A, the collapsed row's own output
            await sub(coinpay, data, 901);   // payee B, resolved from TX_OUTPUTS

            assert.deepStrictEqual(settled(calls), [900, 901],
                'a batched COINPAY must settle every obligation its transaction actually paid');
            assert.strictEqual(calls.created[0].STATUS, 'valid');
            assert.strictEqual(calls.created[1].STATUS, 'valid');
            assert.strictEqual(calls.deleted.length, 0, 'neither sub-command is skipped');
        });

        it('three sellers, three outputs, all three settle and each tally is its own', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger() });

            await sub(coinpay, data, 900);
            await sub(coinpay, data, 901);
            await sub(coinpay, data, 904);

            assert.deepStrictEqual(settled(calls), [900, 901, 904]);
            let ledger = data['BATCH_VALUE_LEDGER'];
            // Payee A is the row's own COIN_DESTINATION, so its draw lands in the shared
            // scalar; every other payee gets its own cell.
            assert.strictEqual(ledger.coinAmountConsumed, '5.00000000');
            assert.deepStrictEqual(ledger.coinPayeeConsumed,
                { [PAYEE_B]: '3.00000000', [PAYEE_C]: '2.00000000' });
        });

        it('an EXHAUSTED payee never blocks a sibling paid separately', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger() });

            await sub(coinpay, data, 900);   // A: draws A's whole 5
            await sub(coinpay, data, 902);   // A again: nothing left, refused
            await sub(coinpay, data, 901);   // B: untouched output, must still settle

            assert.deepStrictEqual(settled(calls), [900, 901],
                'a scalar tally would have let A\'s draw starve B');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '5.00000000');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinPayeeConsumed[PAYEE_B], '3.00000000');
        });

        it('the settled record is filed against the output that actually paid', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger() });

            await sub(coinpay, data, 900);
            await sub(coinpay, data, 901);

            // A's settlement is the row's own output: unchanged.
            assert.strictEqual(calls.created[0].VOUT, 1);
            assert.strictEqual(calls.created[0].COIN_AMOUNT, '5.00000000');
            // B's settlement must NOT be filed under A's payment.
            assert.strictEqual(calls.created[1].VOUT, 2);
            assert.strictEqual(calls.created[1].COIN_AMOUNT, '3.00000000');
        });
    });

    describe('the A5 invariant: one payment settles ONE obligation, not N', function () {

        it('two obligations to the ROW\'S OWN payee with one payment\'s worth: exactly one settles', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger() });   // A paid 5, owes 5 twice

            await sub(coinpay, data, 900);
            await sub(coinpay, data, 902);

            assert.deepStrictEqual(settled(calls), [900]);
            assert.strictEqual(calls.deleted.length, 1, 'the second takes the short-payment path');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '5.00000000');
        });

        it('two obligations to a RESOLVED payee with one payment\'s worth: exactly one settles', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger() });   // B paid 3, owes 3 twice

            await sub(coinpay, data, 901);
            await sub(coinpay, data, 903);

            assert.deepStrictEqual(settled(calls), [901],
                'per-payee resolution must not become a per-payee double-spend');
            assert.strictEqual(calls.deleted.length, 1);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinPayeeConsumed[PAYEE_B], '3.00000000');
        });

        it('TWO obligations\' worth paid to one resolved payee settles both, and a third is refused', async function () {
            let { coinpay, calls } = makeCoinpay();
            let paid = outputs();
            paid[1].value = '6.00000000';                                // B paid two obligations' worth
            let data = batchRow({ TX_OUTPUTS: paid, BATCH_VALUE_LEDGER: seedLedger() });

            await sub(coinpay, data, 901);
            await sub(coinpay, data, 903);

            assert.deepStrictEqual(settled(calls), [901, 903]);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinPayeeConsumed[PAYEE_B], '6.00000000');

            // Exhausted: a third obligation to B settles nothing and consumes nothing.
            await sub(coinpay, data, 901);
            assert.deepStrictEqual(settled(calls), [901, 903]);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinPayeeConsumed[PAYEE_B], '6.00000000',
                'a refused sub-command consumes nothing');
        });

        it('a payee with NO output in the transaction settles nothing', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ TX_OUTPUTS: [outputs()[0]], BATCH_VALUE_LEDGER: seedLedger() });

            await sub(coinpay, data, 901);   // payee B, unpaid

            assert.deepStrictEqual(settled(calls), []);
            assert.strictEqual(calls.deleted.length, 1, 'unchanged destination-mismatch skip');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinPayeeConsumed, undefined,
                'nothing settled, so no cell is created');
        });
    });

    describe('below the flag, the original defect reproduces exactly', function () {

        it('with NO ledger only the lowest-vout payee clears, the other is a destination mismatch', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow();   // no BATCH_VALUE_LEDGER: pre-flag-day BATCH

            await sub(coinpay, data, 900);
            await sub(coinpay, data, 901);

            assert.deepStrictEqual(settled(calls), [900],
                'below the flag a batched COINPAY must still settle exactly one of N');
            assert.strictEqual(calls.deleted.length, 1);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined, 'nothing is invented');
        });

        it('with NO ledger the SAME payee settles every time, byte-identically', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow();

            await sub(coinpay, data, 900);
            await sub(coinpay, data, 900);

            assert.deepStrictEqual(settled(calls), [900, 900], 'the un-drained payment, as before');
            assert.deepStrictEqual(calls.created[1], calls.created[0], 'no drift on re-entry');
        });
    });

    describe('a non-batched COINPAY is unchanged', function () {

        it('each fan-out row settles only the payee ITS output pays', async function () {
            let { coinpay, calls } = makeCoinpay();

            // getDecoderBlockData emits one row per output; every row carries the full set.
            let rowA = batchRow();
            let rowB = batchRow({ ACTION_INDEX: 2, TX_VOUT: 2, COIN_AMOUNT: '3.00000000', COIN_DESTINATION: PAYEE_B });

            await sub(coinpay, rowA, 900);   // A's row settles A's obligation
            await sub(coinpay, rowA, 901);   // A's row must NOT settle B's
            await sub(coinpay, rowB, 901);   // B's row settles B's obligation
            await sub(coinpay, rowB, 900);   // B's row must NOT settle A's

            assert.deepStrictEqual(settled(calls), [900, 901]);
            assert.strictEqual(calls.deleted.length, 2, 'both cross-payee rows skip as before');
            assert.strictEqual(calls.created[0].VOUT, 1);
            assert.strictEqual(calls.created[0].COIN_AMOUNT, '5.00000000');
            assert.strictEqual(calls.created[1].VOUT, 2);
            assert.strictEqual(calls.created[1].COIN_AMOUNT, '3.00000000');
        });

        it('a transaction with no stored outputs falls back to the row destination', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ TX_OUTPUTS: [], BATCH_VALUE_LEDGER: seedLedger() });

            await sub(coinpay, data, 900);

            assert.deepStrictEqual(settled(calls), [900],
                'an empty output set must not break the legacy COIN_DESTINATION path');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '5.00000000');
        });
    });

    describe('ledger shape', function () {

        // Spec row 30 SPLIT the probe contract this case used to pin: a probe now READS
        // the output set (it is inside the same batch) and writes nothing. The old
        // assertion (payee B skipping as a destination mismatch) was the false negative,
        // and the full case lives in feeProbeBatchedCoinpayParity.test.js.
        it('a FEE_PROBE reads its own payee\'s output and mutates nothing', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

            await sub(coinpay, data, 900);
            await sub(coinpay, data, 900);
            await sub(coinpay, data, 901);   // resolved from TX_OUTPUTS, as consensus does

            assert.deepStrictEqual(settled(calls), [900, 900, 901]);
            let ledger = data['BATCH_VALUE_LEDGER'];
            assert.strictEqual(ledger.coinAmountConsumed, '0',
                'a read-only surface must never mutate consensus state');
            assert.strictEqual(ledger.coinPayeeConsumed, undefined);
        });

        it('the per-payee tally holds decimal STRINGS at 8dp, never JS numbers', async function () {
            let { coinpay } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger() });

            await sub(coinpay, data, 901);

            let consumed = data['BATCH_VALUE_LEDGER'].coinPayeeConsumed[PAYEE_B];
            assert.strictEqual(typeof consumed, 'string', 'tally must be a string, got ' + typeof consumed);
            assert.ok(/^\d+\.\d{8}$/.test(consumed), 'tally must be plain 8dp decimal text, got ' + consumed);
            // The sibling rows are untouched by a resolved-payee settlement.
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, '0');
            assert.deepStrictEqual(data['BATCH_VALUE_LEDGER'].oracleFeeConsumed, {});
        });

        it('the shared scalar still records what COINPAY spent from the row\'s own output', async function () {
            // actions/dispense.js reads the same coinAmountConsumed for the COIN_DESTINATION
            // payment; a COINPAY that spent it must stay visible there.
            let { coinpay } = makeCoinpay();
            let paid = outputs();
            paid[0].value = '10.00000000';
            let data = batchRow({ TX_OUTPUTS: paid, COIN_AMOUNT: '10.00000000', BATCH_VALUE_LEDGER: seedLedger() });

            await sub(coinpay, data, 900);
            await sub(coinpay, data, 902);

            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '10.00000000');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinPayeeConsumed, undefined,
                'the row\'s own payee never needs a second cell');
        });
    });
});

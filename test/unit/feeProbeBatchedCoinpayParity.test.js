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
 * test/unit/feeProbeBatchedCoinpayParity.test.js
 *
 * A FEE_PROBE of a batched multi-payee COINPAY agrees with consensus
 * (BATCH_ISSUANCE_LIMITS, spec row 30; the consensus half is pinned by
 * batchedCoinpayMultiPayee.test.js).
 *
 * coinpay.js used to hang two capabilities off one variable: "am I inside a
 * flagged batch" and "may I draw on the tally". Denying a probe both left it
 * resolving no per-payee output, so it answered `destination mismatch` for every
 * payee the collapsed lowest-vout row does not name - a FALSE NEGATIVE on a
 * transaction the chain accepts, which is the same class the _primaryVerdict
 * snapshot in actions.js fixes for ORDER.
 *
 * The split: PRESENCE of BATCH_VALUE_LEDGER is the READ capability (true for a
 * probe), !FEE_PROBE is the WRITE capability (false for a probe).
 *
 * What only this suite can catch:
 *   - a probe of the NON-lowest-vout payee quotes what the chain does, instead of
 *     a mismatch against an output that belongs to a different seller;
 *   - a probe's arithmetic runs off the payee's OWN output, not off the collapsed
 *     row's COIN_AMOUNT (a probe that read the wrong pool could quote valid for
 *     the wrong REASON, and an amount-short case is what tells the two apart);
 *   - the read capability buys NO write capability: the tally object is
 *     byte-identical before and after a probe, including the lazily-created
 *     per-payee cell;
 *   - a payee with no output is still refused, so the fix is not blanket optimism;
 *   - with no ledger key at all a probe is byte-identical to a non-probe, which is
 *     the pre-flag-day and non-BATCH control.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const Utility = require('../../src/utility.js');
const Coinpay = require('../../src/actions/coinpay.js');

// What batch.js seeds once BATCH_ISSUANCE_LIMITS is enabled, verbatim. coinPayeeConsumed
// is absent on purpose: coinpay.js creates that cell lazily, so its APPEARANCE is itself
// evidence of a write.
function seedLedger(){
    return { nativeFeeConsumed: '0', coinAmountConsumed: '0', oracleFeeConsumed: {} };
}

const PAYEE_A = 'payeeAddressAAAA111111111111';
const PAYEE_B = 'payeeAddressBBBB222222222222';
const PAYEE_C = 'payeeAddressCCCC333333333333';

const OBLIGATIONS = {
    900: { ACTION_INDEX: 900, COINPAY_STATUS: 'pending_coinpay', PAYEE_ADDRESS: PAYEE_A, COIN_AMOUNT: '5.00000000', EXPIRATION: 9999999999 },
    901: { ACTION_INDEX: 901, COINPAY_STATUS: 'pending_coinpay', PAYEE_ADDRESS: PAYEE_B, COIN_AMOUNT: '3.00000000', EXPIRATION: 9999999999 },
    902: { ACTION_INDEX: 902, COINPAY_STATUS: 'pending_coinpay', PAYEE_ADDRESS: PAYEE_A, COIN_AMOUNT: '5.00000000', EXPIRATION: 9999999999 },
    // Owed MORE than payee C's output pays: the case that separates "quoted off C's own
    // output" from "quoted off the collapsed row's larger COIN_AMOUNT".
    905: { ACTION_INDEX: 905, COINPAY_STATUS: 'pending_coinpay', PAYEE_ADDRESS: PAYEE_C, COIN_AMOUNT: '4.00000000', EXPIRATION: 9999999999 }
};

function makeCoinpay(){
    let util = new Utility();
    util.config['COIN']    = 'BTC';
    util.config['NETWORK'] = 'regtest';

    let calls = { created: [], deleted: [] };
    let indexerDb = {
        getCoinpayObligationInfo: async (idx) => {
            let row = OBLIGATIONS[Number(idx)];
            return row ? Object.assign({}, row) : false;
        },
        deleteActionIndex: async (idx) => { calls.deleted.push(idx); },
        createCoinpay:     async (row) => { calls.created.push(Object.assign({}, row)); },
        // Ends the run right after the ledger decision, which is the surface under test.
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

// The vout-sorted set db.js getDecoderBlockData attaches to every emitted row.
// A pays 5 at vout 1, B pays 3 at vout 2, C pays 2 at vout 3.
function outputs(){
    return [
        { vout: 1, address: PAYEE_A, value: '5.00000000' },
        { vout: 2, address: PAYEE_B, value: '3.00000000' },
        { vout: 3, address: PAYEE_C, value: '2.00000000' }
    ];
}

// What a batched sub-command sees: collapseOutputFanout kept the LOWEST-VOUT row, so
// COIN_DESTINATION / COIN_AMOUNT / TX_VOUT describe payee A's output for every
// sub-command, whichever seller that sub-command actually owes.
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

async function sub(coinpay, data, obligationIndex){
    await coinpay.parse(['0', String(obligationIndex)], data, false);
}

function settled(calls){
    return calls.created.map(r => r.OBLIGATION_ACTION_INDEX);
}

// The verdict shape a quote reports to a wallet: what settled, what was skipped.
function verdicts(calls){
    return { settled: settled(calls), skipped: calls.deleted.length };
}

describe('FEE_PROBE parity on a batched multi-payee COINPAY @regression @tier1', function () {

    describe('a probe resolves its own payee\'s output', function () {

        it('the NON-lowest-vout payee quotes VALID, not a destination mismatch', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

            await sub(coinpay, data, 901);   // payee B, paid at vout 2

            assert.deepStrictEqual(settled(calls), [901],
                'a probe must quote the verdict the chain gives, not a mismatch against ' +
                'the lowest-vout output, which belongs to a different seller');
            assert.strictEqual(calls.created[0].STATUS, 'valid');
            assert.strictEqual(calls.deleted.length, 0, 'nothing is skipped');
        });

        it('the quote is priced off THAT payee\'s output, so an underpaid payee is still short', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

            // C is paid 2 and owes 4. Quoting off the collapsed row's COIN_AMOUNT (5) would
            // report valid; quoting off C's own output reports the short payment the chain
            // will report.
            await sub(coinpay, data, 905);

            assert.deepStrictEqual(settled(calls), [],
                'a probe reading the wrong pool would quote valid for the wrong reason');
            assert.strictEqual(calls.deleted.length, 1);
        });

        it('a payee with NO output is still refused', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ TX_OUTPUTS: [outputs()[0]], BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

            await sub(coinpay, data, 901);

            assert.deepStrictEqual(settled(calls), [],
                'the read capability is not blanket optimism: an unpaid payee still mismatches');
            assert.strictEqual(calls.deleted.length, 1);
        });

        it('the row\'s OWN payee is unchanged by the split', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

            await sub(coinpay, data, 900);

            assert.deepStrictEqual(settled(calls), [900]);
            assert.strictEqual(calls.created[0].VOUT, 1, 'still filed against the row\'s own output');
            assert.strictEqual(calls.created[0].COIN_AMOUNT, '5.00000000');
        });
    });

    describe('the probe agrees with what the chain does', function () {

        it('every sub-command of a two-payee batch quotes the consensus verdict', async function () {
            let real  = makeCoinpay();
            let probe = makeCoinpay();
            let realData  = batchRow({ BATCH_VALUE_LEDGER: seedLedger() });
            let probeData = batchRow({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

            for(let obligation of [900, 901]){
                await sub(real.coinpay,  realData,  obligation);
                await sub(probe.coinpay, probeData, obligation);
            }

            assert.deepStrictEqual(verdicts(probe.calls), verdicts(real.calls),
                'the quote and the chain must not disagree about a batch either accepts');
            assert.deepStrictEqual(verdicts(real.calls), { settled: [900, 901], skipped: 0 });
        });

        it('a quote of ONE sub-command matches the chain\'s verdict for it, per payee', async function () {
            // A wallet pre-flights each sub-command on its own, which is the shape the
            // per-command tally cannot help with and the per-payee OUTPUT can.
            for(let obligation of [900, 901, 905]){
                let real  = makeCoinpay();
                let probe = makeCoinpay();
                await sub(real.coinpay,  batchRow({ BATCH_VALUE_LEDGER: seedLedger() }), obligation);
                await sub(probe.coinpay, batchRow({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true }), obligation);

                assert.deepStrictEqual(verdicts(probe.calls), verdicts(real.calls),
                    'obligation ' + obligation + ' quoted differently than the chain settles it');
            }
        });
    });

    describe('the read capability buys no write capability', function () {

        it('the tally object is byte-identical before and after a probe', async function () {
            let { coinpay } = makeCoinpay();
            let data   = batchRow({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });
            let before = JSON.stringify(data['BATCH_VALUE_LEDGER']);

            await sub(coinpay, data, 900);   // draws on the shared scalar, on chain
            await sub(coinpay, data, 901);   // creates a per-payee cell, on chain
            await sub(coinpay, data, 900);   // a repeat the chain would refuse

            assert.strictEqual(JSON.stringify(data['BATCH_VALUE_LEDGER']), before,
                'a read-only surface must never mutate consensus state');
            assert.strictEqual(before, JSON.stringify(seedLedger()),
                'and the seed is what it must still equal');
        });

        it('no per-payee cell is created by a probe, however many payees it quotes', async function () {
            let { coinpay } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

            await sub(coinpay, data, 901);
            await sub(coinpay, data, 905);

            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinPayeeConsumed, undefined,
                'the lazily-created cell is itself evidence of a write');
        });

        it('a probe never exhausts the pool, so repeats quote the same answer every time', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger(), FEE_PROBE: true });

            await sub(coinpay, data, 901);
            await sub(coinpay, data, 901);

            assert.deepStrictEqual(settled(calls), [901, 901]);
            assert.deepStrictEqual(calls.created[1], calls.created[0], 'no drift on re-entry');
        });

        it('the same batch WITHOUT the probe marker still drains the tally', async function () {
            // The write capability is the only thing FEE_PROBE takes away; proving it is
            // still there off the probe path is what makes the case above meaningful.
            let { coinpay } = makeCoinpay();
            let data = batchRow({ BATCH_VALUE_LEDGER: seedLedger() });

            await sub(coinpay, data, 900);
            await sub(coinpay, data, 901);

            assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '5.00000000');
            assert.deepStrictEqual(data['BATCH_VALUE_LEDGER'].coinPayeeConsumed, { [PAYEE_B]: '3.00000000' });
        });
    });

    describe('below the flag and off the batch path, a probe is unchanged', function () {

        it('with NO ledger key a probe still reports the destination mismatch', async function () {
            let { coinpay, calls } = makeCoinpay();
            let data = batchRow({ FEE_PROBE: true });   // pre-flag-day BATCH, or no batch

            await sub(coinpay, data, 901);

            assert.deepStrictEqual(settled(calls), [],
                'the read capability is the ledger KEY, so its absence must change nothing');
            assert.strictEqual(calls.deleted.length, 1);
            assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined, 'nothing is invented');
        });

        it('with NO ledger key a probe and a non-probe are byte-identical', async function () {
            let plain = makeCoinpay();
            let probe = makeCoinpay();

            for(let obligation of [900, 901, 905]){
                await sub(plain.coinpay, batchRow(), obligation);
                await sub(probe.coinpay, batchRow({ FEE_PROBE: true }), obligation);
            }

            assert.deepStrictEqual(probe.calls.created, plain.calls.created);
            assert.deepStrictEqual(probe.calls.deleted, plain.calls.deleted);
            assert.deepStrictEqual(verdicts(plain.calls), { settled: [900], skipped: 2 },
                'the pre-flag-day behavior, unchanged');
        });
    });
});

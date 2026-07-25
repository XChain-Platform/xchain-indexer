/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/utility.validateOracleFee.test.js
 *
 * PRICE v1 oracle usage fee verification . Counterparty parity: the
 * address OPENING a Mode B dispenser pays the oracle operator up front, as a
 * real native-coin output, and the create is invalid when that output is missing
 * or short.
 *
 * Every branch here is a consensus verdict on whether a dispenser exists, so
 * each one is pinned: a wrong accept mints a dispenser that never paid, a wrong
 * reject destroys a legitimate one.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const Utility = require('../../src/utility.js');

const ORACLE_ADDR = '1OracleOperatorXXXXXXXXXXXXXXXXXX';
const BLOCK_TIME  = 1790000000;

// Dispenser under test: 1000 PEPECASH escrowed, oracle prices it at $0.05,
// validator says 1 BTC = $50,000 => projected 0.001 BTC, 1% fee => 0.00001 BTC.
function dispenserFields(overrides = {}) {
    return {
        ORACLE_ADDRESS: ORACLE_ADDR,
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'PEPECASH',
        FIAT_CODE:      'USD',
        GIVE_ESCROW:    '1000',
        GET_COIN:       'BTC',
        ...overrides,
    };
}

// db double. oracleRow=null models an oracle with no effective price yet.
function fakeDb({ oracleRow = { value: '0.05', fee: '0.01' }, snapshots = [{ price: '50000' }] } = {}) {
    return {
        async getOraclePrice() { return oracleRow; },
        async getPricesInTimeRange() { return snapshots; },
    };
}

const withOutputs = (outputs) => ({ BLOCK_TIME, TX_OUTPUTS: outputs });

describe('Utility.validateOracleFee() -  @regression @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });

    describe('the oracle must already have an effective price', function () {

        it('rejects when the oracle has published nothing effective yet', async function () {
            // Operator ruling 2026-07-25: a dispenser must reference an oracle that has
            // prices set. Accepting here would be a free-oracle-usage loophole (publish,
            // create immediately, never pay), and the dispenser could not settle anyway.
            const r = await util.validateOracleFee(
                withOutputs([]), dispenserFields(), fakeDb({ oracleRow: null }));
            assert.strictEqual(r.valid, false);
            assert.strictEqual(r.error, 'invalid: ORACLE_ADDRESS (no effective oracle price)');
        });

        it('rejects when no validator price exists to value the fee against', async function () {
            const r = await util.validateOracleFee(
                withOutputs([]), dispenserFields(), fakeDb({ snapshots: [] }));
            assert.strictEqual(r.valid, false);
            assert.match(r.error, /no validator price/);
        });
    });

    describe('zero fee is the common case', function () {

        it('requires no output when the oracle publishes FEE=0', async function () {
            const r = await util.validateOracleFee(
                withOutputs([]), dispenserFields(), fakeDb({ oracleRow: { value: '0.05', fee: '0' } }));
            assert.strictEqual(r.valid, true);
            assert.strictEqual(r.expectedFee, '0.00000000');   // 8-dp like every other return
        });

        it('requires no output when FEE is absent entirely', async function () {
            const r = await util.validateOracleFee(
                withOutputs([]), dispenserFields(), fakeDb({ oracleRow: { value: '0.05', fee: null } }));
            assert.strictEqual(r.valid, true);
        });
    });

    describe('the output must be present and sufficient', function () {

        it('accepts an exact payment to the oracle address', async function () {
            const r = await util.validateOracleFee(
                withOutputs([{ address: ORACLE_ADDR, value: '0.00001' }]),
                dispenserFields(), fakeDb());
            assert.strictEqual(r.valid, true, r.error);
            assert.strictEqual(r.expectedFee, '0.00001000');
        });

        it('accepts an overpayment', async function () {
            const r = await util.validateOracleFee(
                withOutputs([{ address: ORACLE_ADDR, value: '0.001' }]),
                dispenserFields(), fakeDb());
            assert.strictEqual(r.valid, true, r.error);
        });

        it('rejects when the output is missing', async function () {
            const r = await util.validateOracleFee(
                withOutputs([{ address: '1SomeoneElseXXXXXXXXXXXXXXXXXXXXX', value: '1' }]),
                dispenserFields(), fakeDb());
            assert.strictEqual(r.valid, false);
            assert.match(r.error, /missing oracle fee output/);
            assert.strictEqual(r.expectedFee, '0.00001000');
        });

        it('rejects when the output pays the wrong address', async function () {
            // Paying the dispenser's own address, or anyone but the oracle, is not payment.
            const r = await util.validateOracleFee(
                withOutputs([{ address: '1DispenserOwnAddrXXXXXXXXXXXXXXXX', value: '10' }]),
                dispenserFields(), fakeDb());
            assert.strictEqual(r.valid, false);
            assert.match(r.error, /missing oracle fee output/);
        });

        it('rejects a short payment and reports both amounts', async function () {
            const r = await util.validateOracleFee(
                withOutputs([{ address: ORACLE_ADDR, value: '0.000001' }]),
                dispenserFields(), fakeDb());
            assert.strictEqual(r.valid, false);
            assert.match(r.error, /insufficient oracle fee/);
            assert.strictEqual(r.paidAmount,  '0.00000100');
            assert.strictEqual(r.expectedFee, '0.00001000');
        });

        it('allows the FEE_TOLERANCE_MIN band, same as the native fee path', async function () {
            // 0.95 x 0.00001 = 0.0000095. A payer sizing against a marginally
            // different price must not be rejected, which is why the band exists.
            const ok = await util.validateOracleFee(
                withOutputs([{ address: ORACLE_ADDR, value: '0.0000095' }]),
                dispenserFields(), fakeDb());
            assert.strictEqual(ok.valid, true, ok.error);

            const under = await util.validateOracleFee(
                withOutputs([{ address: ORACLE_ADDR, value: '0.0000094' }]),
                dispenserFields(), fakeDb());
            assert.strictEqual(under.valid, false);
        });

        it('matches scriptPubKey_address as well as address', async function () {
            // Decoder-shaped outputs use either key; the native fee path accepts both.
            const r = await util.validateOracleFee(
                withOutputs([{ scriptPubKey_address: ORACLE_ADDR, value: '0.00001' }]),
                dispenserFields(), fakeDb());
            assert.strictEqual(r.valid, true, r.error);
        });

        it('handles a missing TX_OUTPUTS array without throwing', async function () {
            const r = await util.validateOracleFee(
                { BLOCK_TIME }, dispenserFields(), fakeDb());
            assert.strictEqual(r.valid, false);
            assert.match(r.error, /missing oracle fee output/);
        });
    });

    describe('dust', function () {

        it('reads a real dust threshold from the coin bundle, not a silent zero', async function () {
            // dustThreshold lives on the coin bundle's `net` block and is NOT merged onto
            // the indexer's runtime config, so an implementation reading `config.net`
            // silently gets 0 and the dust branch never fires. That is exactly what the
            // first cut of this code did. Pin the value so the wiring cannot rot back.
            assert.strictEqual(String(util.getDustThresholdCoin()), '0.00000546',
                'BTC dust is 546 sats; a 0 here means the coin bundle lookup broke');
        });

        it('requires no output when the computed fee is below the chain dust threshold', async function () {
            // BTC dustThreshold is 546 sats = 0.00000546. A tiny escrow puts the 1%
            // fee under that, where an output would be unspendable anyway.
            const r = await util.validateOracleFee(
                withOutputs([]), dispenserFields({ GIVE_ESCROW: '1' }), fakeDb());
            assert.strictEqual(r.valid, true, r.error);
            assert.strictEqual(r.belowDust, true);
        });

        it('requires an output once the fee reaches dust', async function () {
            // Escrow large enough that 1% clears 546 sats: no belowDust shortcut,
            // and with no output present it must reject.
            const r = await util.validateOracleFee(
                withOutputs([]), dispenserFields({ GIVE_ESCROW: '100000' }), fakeDb());
            assert.strictEqual(r.valid, false);
            assert.match(r.error, /missing oracle fee output/);
        });
    });

    // The whole point of the oraclefeequote API is that a payer can size an output the
    // validator will accept. If the quote and the check ever computed the amount
    // separately they would drift, and every drift is either a rejected honest create or
    // an underpaid oracle. They share quoteOracleFee(); these pin that they still do.
    describe('the quote and the consensus check cannot disagree', function () {

        it('quoteOracleFee returns exactly what validateOracleFee expects', async function () {
            for (const escrow of ['1000', '2000', '999999', '7']) {
                const fields = dispenserFields({ GIVE_ESCROW: escrow });
                const quote  = await util.quoteOracleFee(BLOCK_TIME, fields, fakeDb());
                const check  = await util.validateOracleFee(
                    withOutputs([{ address: ORACLE_ADDR, value: '100' }]), fields, fakeDb());
                assert.strictEqual(util.bcformat(quote.expectedFee, 8), check.expectedFee,
                    'quote and check disagree at escrow ' + escrow);
            }
        });

        it('a payment sized from the quote is accepted by the check', async function () {
            // The round trip a real payer performs: quote, then pay exactly that.
            const fields = dispenserFields();
            const quote  = await util.quoteOracleFee(BLOCK_TIME, fields, fakeDb());
            const paid   = util.bcformat(quote.expectedFee, 8);
            const check  = await util.validateOracleFee(
                withOutputs([{ address: ORACLE_ADDR, value: paid }]), fields, fakeDb());
            assert.strictEqual(check.valid, true, check.error);
        });

        it('the API endpoint delegates rather than recomputing', function () {
            // Source-shape pin: oraclefeequote must call quoteOracleFee. A future edit
            // that inlines the arithmetic there would reintroduce the drift this
            // structure exists to prevent.
            const fs   = require('fs');
            const path = require('path');
            const src  = fs.readFileSync(path.resolve(__dirname, '../../src/api.js'), 'utf8');
            const start = src.indexOf('async oraclefeequote(');
            assert.ok(start > 0, 'the oraclefeequote endpoint must exist');
            const body = src.slice(start, start + 2000);
            assert.ok(/quoteOracleFee\(/.test(body),
                'oraclefeequote must delegate to utility.quoteOracleFee');
            assert.ok(!/computeOracleFee\(/.test(body),
                'oraclefeequote must not compute the fee itself');
        });
    });

    describe('refills are charged on the increase', function () {

        it('scales the fee with the escrow amount passed in', async function () {
            // A v2 refill passes the INCREASE as GIVE_ESCROW, so it pays for what it
            // adds rather than being re-charged on the whole balance. Without this,
            // an opener could escrow 1 token, pay nothing, then refill to millions.
            const small = await util.validateOracleFee(
                withOutputs([{ address: ORACLE_ADDR, value: '1' }]),
                dispenserFields({ GIVE_ESCROW: '1000' }), fakeDb());
            const large = await util.validateOracleFee(
                withOutputs([{ address: ORACLE_ADDR, value: '1' }]),
                dispenserFields({ GIVE_ESCROW: '10000' }), fakeDb());
            assert.strictEqual(small.expectedFee, '0.00001000');
            assert.strictEqual(large.expectedFee, '0.00010000');
        });
    });
});

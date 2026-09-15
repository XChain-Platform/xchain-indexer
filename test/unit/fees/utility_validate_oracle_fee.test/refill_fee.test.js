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
 * test/unit/utility_validate_oracle_fee.test.js
 *
 * PRICE v1 oracle usage fee verification. Counterparty parity: the
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
const Utility = require('../../../../src/utility.js');
const ORACLE_ADDR = '1OracleOperatorXXXXXXXXXXXXXXXXXX';
const BLOCK_TIME  = 1790000000;
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
function fakeDb({ oracleRow = { value: '0.05', fee: '0.01' }, snapshots = [{ price: '50000' }] } = {}) {
    return {
        async getOraclePrice() { return oracleRow; },
        async getPricesInTimeRange() { return snapshots; },
    };
}
const withOutputs = (outputs) => ({ BLOCK_TIME, TX_OUTPUTS: outputs });
let util;
function oracleFeeHooks() {
    beforeEach(function () { util = new Utility(); });
}

describe('Utility.validateOracleFee() - @regression @tier1', function () {
    oracleFeeHooks();
    // The dispenser handler runs quoteOracleFee INSTEAD of validateOracleFee when the
    // transaction is a read-only dry run (data['FEE_PROBE'], set by the public feequote /
    // preflight surfaces only). That substitution is only safe because the two functions
    // differ in exactly one respect: the OUTPUT match. Everything a caller could act on
    // must still refuse identically, or the quote becomes a rubber stamp that says yes to
    // creates the chain will reject.
    describe('the dry-run half drops the output check and NOTHING else', function () {

        it('a live oracle with no outputs: the check refuses, the quote does not', async function () {
            // This asymmetry is the whole defect. A fee quote has no transaction behind it,
            // so it can never carry the output - and the amount that output must hold is
            // precisely what the quote was asked to compute. Before the FEE_PROBE branch,
            // every Mode B dispenser was refused by /feequote AND /preflight, in both fee
            // modes, on every chain, with a verdict no client could satisfy.
            const fields = dispenserFields({ GIVE_ESCROW: '100000' });
            const check  = await util.validateOracleFee(withOutputs([]), fields, fakeDb());
            assert.strictEqual(check.valid, false);
            assert.match(check.error, /missing oracle fee output/);

            const quote = await util.quoteOracleFee(BLOCK_TIME, fields, fakeDb());
            assert.strictEqual(quote.valid, true,
                'a dry run of a perfectly good Mode B dispenser must not be refused for an '
                + 'output that cannot exist yet');
            assert.ok(Number(quote.expectedFee) > 0, 'the quote still states the amount owed');
        });

        it('an oracle with no effective price is refused by BOTH', async function () {
            // The verdict a client CAN act on, and the remedy is "wait a day". If the dry
            // run stopped reporting it, the wallet would sign a create the chain rejects
            // and burn a miner fee (and, off Bitcoin, a non-refundable coin protocol fee).
            const fields = dispenserFields();
            const db     = fakeDb({ oracleRow: null });
            const check  = await util.validateOracleFee(withOutputs([]), fields, db);
            const quote  = await util.quoteOracleFee(BLOCK_TIME, fields, db);
            assert.strictEqual(check.valid, false);
            assert.strictEqual(quote.valid, false);
            assert.match(quote.error, /no effective oracle price/);
            assert.strictEqual(quote.error, check.error, 'the two must refuse identically here');
        });
    });
});

// The same block continued, so neither half of the dry-run parity runs past the
// function-length limit; the titles and their order are the ones above.
describe('Utility.validateOracleFee() - @regression @tier1', function () {
    oracleFeeHooks();

    describe('the dry-run half drops the output check and NOTHING else', function () {

        it('no validator price to value the fee against is refused by BOTH', async function () {
            const fields = dispenserFields();
            const db     = fakeDb({ snapshots: [] });
            const check  = await util.validateOracleFee(withOutputs([]), fields, db);
            const quote  = await util.quoteOracleFee(BLOCK_TIME, fields, db);
            assert.strictEqual(check.valid, false);
            assert.strictEqual(quote.valid, false);
            assert.match(quote.error, /no validator price/);
            assert.strictEqual(quote.error, check.error, 'the two must refuse identically here');
        });

        it('the dispenser handler takes the quote branch only on a probe', function () {
            // Source-shape pin. The branch is deep inside validateAction and has no unit
            // seam, so this guards the one thing a refactor could silently drop: that the
            // waiver is keyed on FEE_PROBE, which only a synthetic dry-run tx ever carries.
            const { concatSrcTreeFiles } = require('../../../helpers/src_tree_files');
            // DISPENSER is a directory (the fee branch sits in its validate_format.js part),
            // read whole so a phase moving between its files never reads as absent.
            const src  = concatSrcTreeFiles(__dirname + '/../../../../src/actions/dispenser');
            assert.ok(/data\['FEE_PROBE'\]\s*\n?\s*\?\s*await this\.util\.quoteOracleFee\(/.test(src),
                'a FEE_PROBE run must call quoteOracleFee');
            assert.ok(/:\s*await this\.util\.validateOracleFee\(/.test(src),
                'a real transaction must still call validateOracleFee');
        });
    });
});

describe('Utility.validateOracleFee() - @regression @tier1', function () {
    oracleFeeHooks();

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

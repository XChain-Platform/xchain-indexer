// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// DISPENSE fill-count and invalid GET_AMOUNT settlement coverage. One part of
// dispenser_amount_positivity.test.js; the shared fixtures are in
// helpers/dispenser_amount_positivity_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const {
    GATE_OFF_NETWORK, BUYER_ADDR, BLOCK_TIME, makeDispenserInfo, freshDispenseSuite,
} = require('./helpers/dispenser_amount_positivity_suite.js');

let indexer, dispense;

async function settle(dispenserOverrides, opts = {}) {
    if (opts.network)
        indexer.config['NETWORK'] = opts.network;
    indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo(dispenserOverrides));
    const data = createBaseData({
        ACTION:      'DISPENSE',
        SOURCE:      BUYER_ADDR,
        COIN_AMOUNT: opts.coinAmount || '0.001',
        BLOCK_TIME,
    });
    await dispense.parse([], data, false);
    return indexer.indexerDb.createDispense.firstCall
        ? indexer.indexerDb.createDispense.firstCall.args[0]
        : null;
}

function fillCountCases() {
    beforeEach(function () {
        ({ indexer, dispense } = freshDispenseSuite());
    });

    afterEach(function () {
        sinon.restore();
    });

    it('control: the arithmetic behind a negative fill count is real', function () {
        // Not a behavioral test: it pins that this fixture DOES drive the multiplier
        // negative, so the settlement cases below cannot pass by never reaching it.
        const util = indexer.util;
        const multiplier = util.bcfloorSaturating(util.bcdiv('0.001', '-0.5', 64));
        assert.strictEqual(multiplier, -1);
        assert.strictEqual(multiplier == 0, false, 'the legacy equality gate does not catch -1');
    });

    it('a negative fill count settles INVALID with the gate on', async function () {
        const rec = await settle({ GET_AMOUNT: '-0.5' });
        assert.ok(rec, 'a dispense row was recorded');
        assert.strictEqual(rec['STATUS'], 'invalid: insufficient funds ');
    });

    it('control: the same negative fill count still settles VALID below the threshold', async function () {
        // The original defect, reproduced: status valid carrying a NEGATIVE give_amount,
        // which the GIVE_REMAINING recompute subtracts and thereby manufactures escrow.
        const rec = await settle({ GET_AMOUNT: '-0.5' }, { network: GATE_OFF_NETWORK });
        assert.ok(rec, 'a dispense row was recorded');
        assert.strictEqual(rec['STATUS'], 'valid');
        assert.ok(indexer.util.bclt(rec['GIVE_AMOUNT'], '0'),
            `expected the legacy path to record a negative give_amount, got ${rec['GIVE_AMOUNT']}`);
    });

    it('a positive fill count is unaffected by the gate', async function () {
        const rec = await settle({}, { coinAmount: '0.02' });
        assert.strictEqual(rec['STATUS'], 'valid');
        assert.strictEqual(String(rec['GIVE_AMOUNT']), '2');
    });
}

function invalidGetAmountCases() {
    beforeEach(function () {
        ({ indexer, dispense } = freshDispenseSuite());
    });

    afterEach(function () {
        sinon.restore();
    });

    it('a zero fill count keeps its legacy status text on both sides of the gate', async function () {
        // The status string is persisted, so the gated reading must not reword it.
        // An empty escrow drives the capacity clamp to a zero fill count, which is the
        // only route to this gate that a payment below GET_AMOUNT does not short-circuit.
        const on  = await settle({ GIVE_REMAINING: '0' }, { coinAmount: '0.01' });
        assert.strictEqual(on['STATUS'], 'invalid: insufficient funds ');
        indexer.indexerDb.createDispense.resetHistory();
        const off = await settle({ GIVE_REMAINING: '0' }, { coinAmount: '0.01', network: GATE_OFF_NETWORK });
        assert.strictEqual(off['STATUS'], 'invalid: insufficient funds ');
    });

    it('control: a non-numeric GET_AMOUNT THROWS out of the raw divide', function () {
        // The pre-fix behavior at this call site, executed rather than asserted: the
        // throw escapes parse() into the block loop, which retries the block forever.
        assert.throws(() => indexer.util.bcdiv('0.001', 'abc', 64));
    });

    it('a non-numeric GET_AMOUNT settles INVALID instead of wedging, ungated', async function () {
        for (const network of ['regtest', GATE_OFF_NETWORK]) {
            indexer.indexerDb.createDispense.resetHistory();
            const rec = await settle({ GET_AMOUNT: 'abc' }, { network });
            assert.ok(rec, `a dispense row was recorded on ${network}`);
            assert.strictEqual(rec['STATUS'], 'invalid: GET_AMOUNT (format)',
                `expected the ungated format reject on ${network}`);
        }
    });

    it("'Infinity' and 'NaN' keep their legacy insufficient-funds verdict", async function () {
        // Both divide to 0 rather than throwing, so the ungated catch must NOT claim
        // them: an isNumeric() pre-screen would, and would change a committed status.
        for (const value of ['Infinity', 'NaN']) {
            indexer.indexerDb.createDispense.resetHistory();
            const rec = await settle({ GET_AMOUNT: value }, { network: GATE_OFF_NETWORK });
            assert.ok(rec, `a dispense row was recorded for ${value}`);
            assert.strictEqual(rec['STATUS'], 'invalid: insufficient funds ',
                `${value} must keep the legacy verdict`);
        }
    });
}

describe('Dispenser amount positivity @regression @tier2', function () {
    describe('DISPENSE settlement: fill count', fillCountCases);
    describe('DISPENSE settlement: fill count', invalidGetAmountCases);
});

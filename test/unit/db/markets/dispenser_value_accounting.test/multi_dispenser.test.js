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
 * test/unit/db/markets/dispenser_value_accounting.test/multi_dispenser.test.js
 *
 * Row 19, the ORDINARY path: one payment behind several open dispensers, with no
 * batch anywhere. The entry file dispenser_value_accounting.test.js carries the
 * row-by-row account of what this suite alone can catch.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const { seedLedger, makeVenue, dispenseData, statuses, getAmounts } = require('./helpers/venue.js');

const THREE = { dispenserIds: [500, 501, 502] };

/* ------------------------------------------------------------------ *
 *  Row 19: one payment, N dispensers, OUTSIDE a batch
 * ------------------------------------------------------------------ */

describe('dispense value accounting: multi-dispenser payment outside a batch @regression @tier1', function () {
    it('one fill\'s worth behind THREE dispensers fills exactly ONE', async function () {
        let { dispense, calls } = makeVenue(THREE);
        let data = dispenseData({ COIN_AMOUNT: '1.00000000' });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls),
            ['valid', 'invalid: GET_AMOUNT (insufficient funds)', 'invalid: GET_AMOUNT (insufficient funds)'],
            'one payment must buy one settlement, with no batch in sight');
        assert.strictEqual(getAmounts(calls)[0], '1.00000000');
    });

    it('BELOW the flag the same payment still fills all THREE (the replay case)', async function () {
        let { dispense, calls } = makeVenue(Object.assign({ limits: false }, THREE));
        let data = dispenseData({ COIN_AMOUNT: '1.00000000' });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid'],
            'the defect must reproduce exactly below the flag or historical blocks fork');
        assert.deepStrictEqual(getAmounts(calls),
            ['1.00000000', '1.00000000', '1.00000000'],
            'and the legacy row shape - the whole payment - stands below the flag');
    });

    it('THREE fills\' worth behind three dispensers fills all three', async function () {
        let { dispense, calls } = makeVenue(THREE);
        let data = dispenseData({ COIN_AMOUNT: '3.00000000' });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls),
            ['1.00000000', '1.00000000', '1.00000000']);
    });

    it('the non-batch tally never appears on data as a BATCH_VALUE_LEDGER', async function () {
        // That key's PRESENCE means "inside a batch" to batch.js, coinpay.js and
        // validateOracleFee. Fabricating one here would lie to all three.
        let { dispense } = makeVenue(THREE);
        let data = dispenseData({ COIN_AMOUNT: '1.00000000' });

        await dispense.parse(null, data, false);

        assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
        assert.ok(!Object.prototype.hasOwnProperty.call(data, 'BATCH_VALUE_LEDGER'));
    });
});

describe('dispense value accounting: multi-dispenser payment outside a batch @regression @tier1', function () {
    it('the tally is scoped to ONE action: a second DISPENSE gets a fresh payment', async function () {
        // Outside a batch, one parse() IS one transaction. Two of them are two payments,
        // and the second must not be starved by the first.
        let { dispense, calls } = makeVenue();
        let data = dispenseData({ COIN_AMOUNT: '1.00000000' });

        await dispense.parse(null, data, false);
        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls), ['1.00000000', '1.00000000']);
    });

    it('a FEE_PROBE outside a batch opens no tally at all', async function () {
        let { dispense, calls } = makeVenue(THREE);
        let data = dispenseData({ COIN_AMOUNT: '1.00000000', FEE_PROBE: true });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid'],
            'the quote surfaces must keep reading the un-drained payment');
        assert.deepStrictEqual(getAmounts(calls),
            ['1.00000000', '1.00000000', '1.00000000'],
            'and a probe records the legacy figure, having attributed nothing');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
    });

    it('a batch ledger, when present, still wins over the local tally', async function () {
        // Inside a batch the shared pool is the one that must drain, so a second
        // sub-command sees what the first spent across ALL its dispensers.
        let { dispense, calls } = makeVenue(THREE);
        let data = dispenseData({ COIN_AMOUNT: '2.00000000', BATCH_VALUE_LEDGER: seedLedger() });

        await dispense.parse(null, data, false);
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '2.00000000',
            'two of the three dispensers were served by the two fills paid for');

        await dispense.parse(null, data, false);
        assert.deepStrictEqual(statuses(calls).slice(3),
            ['invalid: GET_AMOUNT (insufficient funds)',
             'invalid: GET_AMOUNT (insufficient funds)',
             'invalid: GET_AMOUNT (insufficient funds)'],
            'the exhausted batch pool feeds no further sub-command');
    });

    it('no dispenser matched: the gate is not even consulted', async function () {
        let { dispense, calls } = makeVenue({ dispenserIds: [] });
        let data = dispenseData();

        await dispense.parse(null, data, false);

        assert.strictEqual(calls.created.length, 0);
        assert.ok(!calls.gateQueries.includes('BATCH_ISSUANCE_LIMITS'),
            'a DISPENSE that matches nothing has no value to tally');
    });
});

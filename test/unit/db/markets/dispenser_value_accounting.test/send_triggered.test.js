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
 * test/unit/db/markets/dispenser_value_accounting.test/send_triggered.test.js
 *
 * Row 20, the SEND path: util.processDispenserSends builds its own data object,
 * so a SEND-triggered DISPENSE must carry its own value and never the enclosing
 * batch's tally. The entry file dispenser_value_accounting.test.js carries the
 * row-by-row account of what this suite alone can catch.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const { DISPENSER_ADDRESS, BUYER, seedLedger, makeVenue, statuses, getAmounts } = require('./helpers/venue.js');

/* ------------------------------------------------------------------ *
 *  Row 20: SEND-triggered dispenses carry their OWN value
 * ------------------------------------------------------------------ */

// A venue whose processAction routes DISPENSE into a real handler, so a SEND can be
// followed all the way through to the dispense rows it writes.
function makeSendVenue(opts){
    opts = opts || {};
    let venue = makeVenue(opts);
    let seen  = [];
    venue.actions.processAction = async (action, params, data) => {
        if(action !== 'DISPENSE')
            return;                       // DISPENSER_CLOSE and friends: not this test's subject
        seen.push(data);
        await venue.dispense.parse(null, data, false);
    };
    venue.seen = seen;
    return venue;
}

function sendRow(amount){
    return { source: BUYER, coin: 'BTC', tick: 'PAYTOKEN', amount: amount, destination: DISPENSER_ADDRESS };
}

function sendDb(sends){
    return { findDispenserSends: async () => sends };
}

describe('dispense value accounting: SEND-triggered dispenses @regression @tier1', function () {

    it('the DISPENSE never inherits the enclosing batch\'s value tally', async function () {
        let venue = makeSendVenue();
        let db    = sendDb([sendRow('1.00000000')]);
        let info  = { ACTION_INDEX: 1, BLOCK_INDEX: 100, BLOCK_TIME: 1000, TX_INDEX: 7,
                      BATCH_VALUE_LEDGER: seedLedger() };

        await venue.util.processDispenserSends(venue.actions, db, info);

        assert.strictEqual(venue.seen.length, 1);
        assert.strictEqual(venue.seen[0]['BATCH_VALUE_LEDGER'], undefined,
            'a SEND amount is its own debit, not a claim on the transaction coin pool');
        assert.ok(!Object.prototype.hasOwnProperty.call(venue.seen[0], 'BATCH_VALUE_LEDGER'));
        assert.strictEqual(info['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0',
            'and the batch pool is left untouched by it');
    });

    it('one SEND behind THREE dispensers still settles exactly ONE', async function () {
        // The property holds by construction: with no ledger inherited, the handler opens
        // its own tally over THIS send's amount. A batched SEND arrives the same way.
        let venue = makeSendVenue({ dispenserIds: [500, 501, 502] });
        let db    = sendDb([sendRow('1.00000000')]);
        let info  = { ACTION_INDEX: 1, BLOCK_INDEX: 100, BLOCK_TIME: 1000, TX_INDEX: 7,
                      BATCH_VALUE_LEDGER: seedLedger() };

        await venue.util.processDispenserSends(venue.actions, db, info);

        assert.deepStrictEqual(statuses(venue.calls),
            ['valid', 'invalid: GET_AMOUNT (insufficient funds)', 'invalid: GET_AMOUNT (insufficient funds)']);
        assert.strictEqual(getAmounts(venue.calls)[0], '1.00000000');
    });

    it('TWO sends in one transaction are two independent values, not one', async function () {
        // The shape the batch-cumulative rule must NOT collapse: each SEND was debited
        // separately, so each buys its own fill.
        let venue = makeSendVenue();
        let db    = sendDb([sendRow('1.00000000'), sendRow('1.00000000')]);
        let info  = { ACTION_INDEX: 1, BLOCK_INDEX: 100, BLOCK_TIME: 1000, TX_INDEX: 7,
                      BATCH_VALUE_LEDGER: seedLedger() };

        await venue.util.processDispenserSends(venue.actions, db, info);

        assert.deepStrictEqual(statuses(venue.calls), ['valid', 'valid']);
        assert.strictEqual(info['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0');
    });

    it('BELOW the flag one SEND behind three dispensers still settles all three', async function () {
        let venue = makeSendVenue({ dispenserIds: [500, 501, 502], limits: false });
        let db    = sendDb([sendRow('1.00000000')]);
        let info  = { ACTION_INDEX: 1, BLOCK_INDEX: 100, BLOCK_TIME: 1000, TX_INDEX: 7 };

        await venue.util.processDispenserSends(venue.actions, db, info);

        assert.deepStrictEqual(statuses(venue.calls), ['valid', 'valid', 'valid']);
    });
});

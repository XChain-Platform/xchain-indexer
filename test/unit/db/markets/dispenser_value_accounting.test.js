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
 * test/unit/db/markets/dispenser_value_accounting.test.js
 *
 * DISPENSE value accounting beyond the batch ledger (BATCH_ISSUANCE_LIMITS,
 * spec rows 18-20; sibling of batch_settlement_value_ledger.test.js, which pins the
 * in-batch half).
 *
 * Row 18 - the RECORD. dispenses.GET_AMOUNT wrote data['COIN_AMOUNT'], the whole
 *   payment, into every row, so three batched sub-commands each recorded the full
 *   payment while consuming a third of it. The row must carry what the dispense was
 *   charged, and must carry exactly the figure the pool was drained by, so the
 *   record and the accounting can never disagree.
 *
 * Row 19 - the ORDINARY path. findMatchingDispensers returns every open dispenser
 *   behind the paid address and the handler loops over all of them, each pricing
 *   itself against the same untouched payment: one payment, N settlements, with no
 *   batch anywhere. A tightening, so it is gated, and below the gate the defect must
 *   still reproduce exactly (the replay case).
 *
 * Row 20 - the SEND path. util.processDispenserSends builds its own data object.
 *   It must NOT inherit the enclosing batch's value tally (a SEND's amount is its
 *   own debit, and it is denominated in the sent token, not in the transaction's
 *   coin), and the one-value-N-settlements property must hold there anyway, by
 *   construction, so a future batched SEND cannot reintroduce the defect.
 *
 * What only this suite can catch:
 *   - a recorded GET_AMOUNT that drifts from the amount actually consumed;
 *   - the multi-dispenser loop double-spending one payment outside a batch;
 *   - the non-batch tally masquerading as a batch by appearing on
 *     data['BATCH_VALUE_LEDGER'], which other readers take to mean "inside a batch";
 *   - a SEND-triggered dispense inheriting the batch tally.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const { seedLedger, makeUtil, makeVenue, dispenseData, statuses, getAmounts } = require('./dispenser_value_accounting.test/helpers/venue.js');

/* ------------------------------------------------------------------ *
 *  Row 18: the row records the ATTRIBUTED cost, not the whole payment
 * ------------------------------------------------------------------ */

describe('dispense value accounting: recorded GET_AMOUNT @regression @tier1', function () {
    it('inside a batch each sub-command records the fill it bought, not the whole payment', async function () {
        let { dispense, calls } = makeVenue();
        // 3 coin pays for three 1-coin fills across three sub-commands.
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });

        for(let i = 0; i < 3; i++)
            await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls),
            ['1.00000000', '1.00000000', '1.00000000'],
            'each row must carry the 1 coin it spent, not the 3 coin the transaction paid');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '3.00000000');
    });

    it('the recorded amounts sum to exactly what the pool was drained by', async function () {
        // The invariant that makes the record trustworthy: sum(rows) == tally.
        let { dispense, calls } = makeVenue();
        let data = dispenseData({ COIN_AMOUNT: '2.00000000', BATCH_VALUE_LEDGER: seedLedger() });
        let util = makeUtil();

        for(let i = 0; i < 2; i++)
            await dispense.parse(null, data, false);

        let sum = getAmounts(calls).reduce((acc, v) => util.bcformat(util.bcadd(acc, v, 8), 8), '0');
        assert.strictEqual(sum, data['BATCH_VALUE_LEDGER'].coinAmountConsumed);
        assert.strictEqual(sum, '2.00000000');
    });

    it('an overpaid single fill records only the fill, leaving the tip in the pool', async function () {
        // 3 coin against a dispenser that can serve one 1-coin fill: the clamp means
        // one fill was bought and 2 coin is still spendable by a sibling command.
        let { dispense, calls } = makeVenue();
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid']);
        assert.strictEqual(getAmounts(calls)[0], '1.00000000');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '1.00000000');
    });

    it('below the flag, and with no batch, the whole payment is recorded exactly as before', async function () {
        let { dispense, calls } = makeVenue({ limits: false });
        let data = dispenseData();

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid']);
        assert.strictEqual(getAmounts(calls)[0], '3.00000000',
            'the legacy record shape must replay byte-identically below the flag');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
    });
});

describe('dispense value accounting: recorded GET_AMOUNT @regression @tier1', function () {
    it('an INVALID dispense attributes nothing and keeps the legacy figure', async function () {
        // Payment below one fill: nothing settles, so nothing is attributed and the row
        // still records what was paid at the failed attempt.
        let { dispense, calls } = makeVenue();
        let data = dispenseData({ COIN_AMOUNT: '0.50000000', BATCH_VALUE_LEDGER: seedLedger() });

        await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['invalid: GET_AMOUNT (insufficient funds)']);
        assert.strictEqual(getAmounts(calls)[0], '0.50000000');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0',
            'a refused dispense consumes nothing');
    });

    it('the v0 FIAT path records its fill price too', async function () {
        // 10.00 USD a fill against a BTC/USD snapshot of 100: one fill costs 0.1 coin.
        let { dispense, calls } = makeVenue({
            dispenser: { FIAT: 'USD', FIAT_AMOUNT: '10.00', GET_AMOUNT: '0' },
            snapshots: [{ price: '100.00000000', timestamp: 990 }]
        });
        let data = dispenseData({ COIN_AMOUNT: '0.30000000', BATCH_VALUE_LEDGER: seedLedger() });

        for(let i = 0; i < 3; i++)
            await dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(calls), ['valid', 'valid', 'valid']);
        assert.deepStrictEqual(getAmounts(calls), ['0.10000000', '0.10000000', '0.10000000']);
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0.30000000');
    });

    it('a pricing path that returns no per-unit price attributes nothing, not a silent zero', async function () {
        // A matcher that priced units but handed back no per-unit cost would multiply out
        // to zero, and a zero written into the row reads as "this dispense was free".
        // Attribute nothing instead, and leave the legacy figure standing.
        let venue = makeVenue({ dispenser: { FIAT: 'USD', FIAT_AMOUNT: '10.00', GET_AMOUNT: '0' } });
        venue.util.reversePriceMatch = async () => ({ units: 3 });   // no btcPerToken
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });

        await venue.dispense.parse(null, data, false);

        assert.deepStrictEqual(statuses(venue.calls), ['valid']);
        assert.strictEqual(getAmounts(venue.calls)[0], '3.00000000');
        assert.strictEqual(data['BATCH_VALUE_LEDGER'].coinAmountConsumed, '0');
    });

    it('the recorded amount is a plain 8dp decimal STRING', async function () {
        let { dispense, calls } = makeVenue();
        let data = dispenseData({ BATCH_VALUE_LEDGER: seedLedger() });

        await dispense.parse(null, data, false);

        let recorded = calls.created[0]['GET_AMOUNT'];
        assert.strictEqual(typeof recorded, 'string', 'got ' + typeof recorded);
        assert.ok(/^\d+\.\d{8}$/.test(recorded), 'got ' + recorded);
    });
});

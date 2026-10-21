/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { getTestConfig } = require('../../../fixtures/config');
const Utility = require('../../../../src/utility');
const { ledgerArrayFromSumRows } = require('../../../../src/db/misc/credit_debit_sum_sql');
const { LEDGER_AMOUNT_PRECISION } = require('../../../../src/consensus/ledger_amount_precision_gate');

const util = new Utility(getTestConfig());

function fold(a, b) {
    return util.bcstr(util.bcadd(util.bcadd(0, a, LEDGER_AMOUNT_PRECISION), b, LEDGER_AMOUNT_PRECISION));
}

describe('ledgerArrayFromSumRows', function () {
    it('shapes grouped rows into the array the fold returns', function () {
        for (const zero of [0, '0']) {
            const out = ledgerArrayFromSumRows([
                { tick_id: 11, amount: '2.000000000000000001', non_canonical: zero },
                { tick_id: 12, amount: '3.250000000000000000', non_canonical: zero },
            ], util);
            assert.ok(Array.isArray(out));
            assert.strictEqual(out.length, 13);
            assert.deepStrictEqual(Object.keys(out), ['11', '12']);
            assert.strictEqual(util.bcstr(out[11]), '2.000000000000000001');
            assert.strictEqual(util.bcstr(out[12]), '3.25');
            assert.strictEqual(util.bcstr(out[11]), fold('2', '0.000000000000000001'));
            assert.strictEqual(util.bcstr(out[12]), fold('3', '0.25'));
        }
    });

    it('returns null when any row is non canonical, as number, string or BigInt', function () {
        for (const n of [1, '1', 1n]) {
            assert.strictEqual(ledgerArrayFromSumRows([
                { tick_id: 11, amount: '1', non_canonical: 0 },
                { tick_id: 12, amount: '1', non_canonical: n },
            ], util), null);
            assert.strictEqual(ledgerArrayFromSumRows([{ tick_id: 11, amount: '1', non_canonical: n }], util), null);
        }
    });

    it('returns an empty array for no rows', function () {
        const out = ledgerArrayFromSumRows([], util);
        assert.ok(Array.isArray(out));
        assert.strictEqual(out.length, 0);
    });
});

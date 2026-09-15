/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db/db_integer_field_range.test.js
 *
 * A wire field that lands in an integer column must never reach the bind with a
 * value the column cannot represent.
 *
 * NUMBER_FIELDS normalization bounds a field's TYPE and not its MAGNITUDE, so
 * EXPIRATION='18446744073709551616' cleared every format check and was bound into
 * orders.expiration BIGINT UNSIGNED - which throws inside the block transaction
 * under STRICT_TRANS_TABLES (the retry loop then re-runs the same deterministic
 * transaction forever) or clamps under a permissive sql_mode (two nodes store
 * different values). The action handlers write their row even when the action is
 * invalid, so rejecting the action is not on its own enough.
 *
 * Negative control: drop the INTEGER_FIELDS loop from normalizeDataValues and the
 * out-of-range / negative cases below resolve to the original value instead of
 * null; drop the validator clause and the "still invalid" case goes red. The
 * money-field case is the control in the other direction - it goes red if the
 * guard ever leaks onto a VARCHAR amount column.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');

const U64_MAX = '18446744073709551615';
const OVER_U64 = '18446744073709551616';

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
}

afterEach(function () { sinon.restore(); });

describe('integer-backed wire fields are range-guarded before the bind @regression @tier1', function () {
    it('nulls an EXPIRATION one past the BIGINT UNSIGNED maximum', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({ ACTION: 'ORDER', EXPIRATION: OVER_U64 });
        assert.strictEqual(out['EXPIRATION'], null);
    });

    it('keeps the BIGINT UNSIGNED maximum itself, which the column can store', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({ ACTION: 'ORDER', EXPIRATION: U64_MAX });
        assert.strictEqual(String(out['EXPIRATION']), U64_MAX);
    });

    it('nulls a negative value bound for an UNSIGNED column', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({ ACTION: 'ORDER', EXPIRATION: '-1' });
        assert.strictEqual(out['EXPIRATION'], null);
    });

    it('leaves an ordinary in-range expiration untouched', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({ ACTION: 'ORDER', EXPIRATION: '9999999999' });
        assert.strictEqual(String(out['EXPIRATION']), '9999999999');
    });

    it('honours a narrower column: COOLDOWN_BLOCKS is INT UNSIGNED, not BIGINT', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({ ACTION: 'ISSUE', COOLDOWN_BLOCKS: '4294967296' });
        assert.strictEqual(out['COOLDOWN_BLOCKS'], null);
        const ok = db.normalizeDataValues({ ACTION: 'ISSUE', COOLDOWN_BLOCKS: '4294967295' });
        assert.strictEqual(String(ok['COOLDOWN_BLOCKS']), '4294967295');
    });

    // The control in the other direction. The amount family is VARCHAR(250) and
    // legitimately carries fixed-decimal strings far larger than any integer column;
    // range-clamping one would destroy a real balance.
    it('never touches the VARCHAR amount fields, however large', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({
            ACTION:      'ISSUE',
            MAX_SUPPLY:  '184467440737095516150.00000000',
            GIVE_AMOUNT: '999999999999999999999.00000000'
        });
        assert.strictEqual(String(out['MAX_SUPPLY']),  '184467440737095516150.00000000');
        assert.strictEqual(String(out['GIVE_AMOUNT']), '999999999999999999999.00000000');
    });
});

describe('integer-backed wire fields are range-guarded before the bind @regression @tier1', function () {
    it('every INTEGER_FIELDS maximum is an unsigned column bound, never a money field', function () {
        const db = makeDb();
        const map = db.config['INTEGER_FIELDS'];
        const AMOUNTS = ['AMOUNT', 'GIVE_AMOUNT', 'GET_AMOUNT', 'MAX_SUPPLY', 'MIN_AMOUNT',
                         'FEE', 'FEE_AMOUNT', 'DEPOSIT', 'GAS_ESCROW', 'GIVE_ESCROW',
                         'CALLBACK_AMOUNT', 'FIAT_AMOUNT', 'MINT_SUPPLY', 'BALANCES'];
        for (const field of AMOUNTS)
            assert.ok(!(field in map), field + ' is a VARCHAR amount column and must not be range-guarded');
        for (const field of Object.keys(map)) {
            assert.ok(db.config['NUMBER_FIELDS'].indexOf(field) !== -1,
                field + ' must also be numeric-normalized');
            assert.match(String(map[field]), /^[0-9]+$/,
                field + ' maximum is a decimal digit string, compared as BigInt');
        }
    });
});

describe('exceedsUnsignedColumn proves overflow and never guesses @regression @tier1', function () {

    it('answers on the exact boundary without losing precision above 2^53', function () {
        const util = new Utility();
        assert.strictEqual(util.exceedsUnsignedColumn(U64_MAX, U64_MAX), false);
        assert.strictEqual(util.exceedsUnsignedColumn(OVER_U64, U64_MAX), true);
        // The naive Number() compare this replaces: both sides round to the same float,
        // so it would answer false for the value one past the maximum.
        assert.strictEqual(Number(OVER_U64) > Number(U64_MAX), false);
    });

    it('answers false for a spelling it cannot prove out of range', function () {
        const util = new Utility();
        assert.strictEqual(util.exceedsUnsignedColumn('1.0', U64_MAX), false);
        assert.strictEqual(util.exceedsUnsignedColumn('not a number', U64_MAX), false);
        assert.strictEqual(util.exceedsUnsignedColumn(null, U64_MAX), false);
    });
});

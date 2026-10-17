/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
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
 * test/unit/cross_chain/pass_retirement_age.test.js
 *
 * The retirement age (src/consensus/pass_retirement): a row is aged at block B
 * exactly when its pass's bind rule would already have selected it at B - grace,
 * by height where the admission era binds by height and by the decoder's
 * protocol time otherwise, and it never reads a row older than it is.
 ********************************************************************/

'use strict';

const assert = require('assert');

const pr = require('../../../src/consensus/pass_retirement');

const T = (h) => 1700000000 + h * 600;

function db(admission) {
    return { mirrorAdmissionActiveAt: () => admission, admitColumn: () => 'admit_block_ltc' };
}
const clock = (fn) => ({ protocolTimeForStoredBlock: async (h) => fn(h) });

describe('pass retirement age @regression', function () {

    it('sizes the grace at about two hours of each chain and takes the longest for an unknown chain', function () {
        assert.deepStrictEqual({ BTC: pr.retirementGraceBlocks('BTC'), LTC: pr.retirementGraceBlocks('LTC'), DOGE: pr.retirementGraceBlocks('DOGE') },
            { BTC: 12, LTC: 48, DOGE: 120 });
        assert.strictEqual(pr.retirementGraceBlocks('XYZ'), 120);
    });

    it('ages a clock-bound row when the block a grace back had reached its effective_time', async function () {
        const row = { effective_time: T(52), admit_block_ltc: null };
        assert.strictEqual(await pr.rowAgedOut(db(false), clock(T), row, 99, 'LTC'), false);
        assert.strictEqual(await pr.rowAgedOut(db(false), clock(T), row, 100, 'LTC'), true);
    });

    it('ignores admit_block outside the admission era, and effective_time inside it', async function () {
        const row = { effective_time: 4102444800, admit_block_ltc: 10 };
        assert.strictEqual(await pr.rowAgedOut(db(false), clock(T), row, 100, 'LTC'), false, 'clock era: the far-future stamp holds it');
        assert.strictEqual(await pr.rowAgedOut(db(true), clock(T), row, 57, 'LTC'), false);
        assert.strictEqual(await pr.rowAgedOut(db(true), clock(T), row, 58, 'LTC'), true, 'admission era: 10 + 48');
    });

    it('falls back to the clock for a row with no height for this chain in the admission era', async function () {
        const row = { effective_time: T(52), admit_block_ltc: null };
        assert.strictEqual(await pr.rowAgedOut(db(true), clock(T), row, 100, 'LTC'), true);
        assert.strictEqual(pr.heightAgedOut(db(true), row, 100, 'LTC'), null);
    });

    it('never ages a row whose admission column is not a height, or whose effective_time is missing', async function () {
        assert.strictEqual(await pr.rowAgedOut(db(true), clock(T), { admit_block_ltc: 'x', effective_time: T(1) }, 1000, 'LTC'), false);
        assert.strictEqual(await pr.rowAgedOut(db(false), clock(T), { effective_time: null }, 1000, 'LTC'), false);
    });

    it('never ages a row when the reference block is below genesis or not stored', async function () {
        const row = { effective_time: 0 };
        assert.strictEqual(await pr.rowAgedOut(db(false), clock(T), row, 47, 'LTC'), false);
        assert.strictEqual(await pr.rowAgedOut(db(false), clock(() => false), row, 1000, 'LTC'), false);
    });

    it('can only read a row younger on a clock that steps back, never older', async function () {
        // Block 52 is stamped back at T(50), so a row effective at T(52) is first selectable at
        // 53 and is a grace old at 101; at 100 the reference block is the stepped-back 52.
        const stepBack = (h) => h === 52 ? T(50) : T(h);
        const row = { effective_time: T(52) };
        assert.strictEqual(await pr.rowAgedOut(db(false), clock(stepBack), row, 100, 'LTC'), false);
        assert.strictEqual(await pr.rowAgedOut(db(false), clock(stepBack), row, 101, 'LTC'), true);
    });
});

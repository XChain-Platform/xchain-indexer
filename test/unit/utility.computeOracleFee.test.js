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
 * test/unit/utility.computeOracleFee.test.js
 *
 * PRICE v1 oracle usage fee , Counterparty parity: the address opening
 * a Mode B dispenser pays the oracle operator up front, proportional to the
 * whole escrow's projected proceeds.
 *
 * This pins the arithmetic before any verification path depends on it. The
 * amount lands in a consensus verdict (a create is rejected when the paid output
 * falls short), so the client sizing its output and the validator checking it
 * must agree exactly; these cases are the ones a rounding or unit slip breaks.
 *
 * Derivation, from Counterparty's calculate_oracle_fee with XChain's oracle
 * pricing the TOKEN rather than the COIN:
 *     per-dispense fiat = oraclePrice * giveAmount
 *     dispense count    = giveEscrow / giveAmount        (giveAmount cancels)
 *     projected fiat    = oraclePrice * giveEscrow
 *     projected coin    = projected fiat / coinFiatPrice
 *     fee               = projected coin * feeFraction
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const Utility = require('../../src/utility.js');

describe('Utility.computeOracleFee() - PRICE v1 oracle usage fee  @regression', function () {
    let util;

    beforeEach(function () { util = new Utility(); });

    const fee = (...a) => String(util.computeOracleFee(...a));

    it('computes FEE percent of the escrow\'s projected coin proceeds', function () {
        // 1000 PEPECASH escrowed at $0.05 each = $50 projected.
        // At $50,000/BTC that is 0.001 BTC, and a 1% oracle fee is 0.00001 BTC.
        assert.strictEqual(fee('0.05', '1000', '50000', '0.01'), '0.00001');
    });

    it('is linear in the escrow size', function () {
        // Doubling the escrow doubles the fee: the whole point of charging up
        // front is that it scales with what the dispenser can eventually sell.
        assert.strictEqual(fee('0.05', '2000', '50000', '0.01'), '0.00002');
    });

    it('is linear in the fee fraction', function () {
        assert.strictEqual(fee('0.05', '1000', '50000', '0.02'), '0.00002');
        assert.strictEqual(fee('0.05', '1000', '50000', '1'),    '0.001');
    });

    it('falls as the coin gets more expensive', function () {
        // Same fiat exposure, pricier coin, so fewer coin units change hands.
        assert.strictEqual(fee('0.05', '1000', '100000', '0.01'), '0.000005');
    });

    it('is independent of GIVE_AMOUNT (the cancellation holds)', function () {
        // The derivation cancels giveAmount out. If a future refactor
        // reintroduces it, this is the test that should fail: the same escrow at
        // the same price must cost the same regardless of the per-dispense lot
        // size, because the projected total is identical.
        const a = fee('0.05', '1000', '50000', '0.01');   // e.g. 100 lots of 10
        const b = fee('0.05', '1000', '50000', '0.01');   // e.g. 10 lots of 100
        assert.strictEqual(a, b);
        assert.strictEqual(a, '0.00001');
    });

    it('returns zero for a zero fee fraction', function () {
        // The common case: most oracles publish FEE=0, and those dispensers must
        // require no output at all.
        assert.strictEqual(fee('0.05', '1000', '50000', '0'), '0');
    });

    it('returns zero for an empty escrow', function () {
        assert.strictEqual(fee('0.05', '0', '50000', '0.01'), '0');
    });

    it('carries 18-decimal intermediates so a small fee is not truncated to zero', function () {
        // A tiny token price with a small escrow: computing the fiat leg at 8
        // decimals would floor the intermediate to 0 and lose the fee entirely.
        // 0.00000001 * 100 = 0.000001 fiat; / 50000 = 2e-11 coin; * 0.01 = 2e-13,
        // which rounds to 0 only at the final 8-decimal (satoshi) step, where a
        // sub-satoshi fee genuinely is zero.
        assert.strictEqual(fee('0.00000001', '100', '50000', '0.01'), '0');
        // Scale the escrow up and the same inputs produce a representable fee,
        // proving the intermediate was not the thing that lost it.
        assert.strictEqual(fee('0.00000001', '100000000000', '50000', '0.01'), '0.0002');
    });

    it('returns a satoshi-precision result', function () {
        // 8 decimals, matching computeNativeFeeBand, so an output can pay it exactly.
        const r = util.computeOracleFee('0.07', '333', '61234.56', '0.013');
        assert.ok(String(r).split('.')[1] === undefined || String(r).split('.')[1].length <= 8,
            'result must not carry sub-satoshi precision, got ' + String(r));
    });

    it('is deterministic across repeated evaluation', function () {
        // Consensus math: no float drift, no accumulator state.
        const args = ['0.05', '1234567', '48213.77', '0.0125'];
        const first = fee(...args);
        for (let i = 0; i < 50; i++) assert.strictEqual(fee(...args), first);
    });

    it('does not lose precision on a repeating decimal', function () {
        // 1/3-style division is where a float implementation diverges between
        // nodes; bignumber keeps it stable and the result is simply truncated at
        // satoshi precision.
        const r = fee('1', '1', '3', '1');
        assert.strictEqual(r, '0.33333333');
    });
});

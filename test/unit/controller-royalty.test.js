'use strict';

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
 * Programmable policy layer: Phase D royalty/fee split (applyProceedsSplit).
 *
 * A controlled-token sale guard returns payoutLegs [{to, bps}] at create; the protocol
 * applies them to the SELLER's proceeds at each match via Utility.applyProceedsSplit.
 * These tests pin the split math: basis-point cuts of the actual fill, exact conservation
 * (seller remainder + legs == proceeds), and the fail-closed fallbacks (malformed / over-cap
 * legs → seller keeps everything). Pure (no DB/VM) so they run on any Node version. The
 * end-to-end match settlement is exercised on Node 22 / test-host.
 *
 * Spec: xchain-documentation/protocol/Controller_Bound_Tokens.md
 ********************************************************************/

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const Utility = require('../../src/utility.js');

const util = new Utility();

// Amounts come back as mathjs Decimals (the bcmul/bcdiv convention used across settlement).
// Normalize a credit-tuple list to [tick, decimalString, address] for comparison.
function norm(credits) {
    return credits.map(c => [c[0], String(c[1]), c[2]]);
}
// Sum the amounts of a credit-tuple list ([tick, amount, address]) at `dec` precision.
function sumAmounts(credits, dec) {
    let total = '0';
    for (const c of credits) total = util.bcadd(total, c[1], dec);
    return String(total);
}

describe('Programmable policy layer: Phase D royalty/fee split @regression', function () {

    it('no legs → a single full-proceeds credit to the seller', function () {
        const out = util.applyProceedsSplit('TOK', '1000', 'seller', null, 8, 10000);
        assert.deepStrictEqual(out, [['TOK', '1000', 'seller']]);
    });

    it('empty legs array → single full credit', function () {
        const out = util.applyProceedsSplit('TOK', '1000', 'seller', [], 8, 10000);
        assert.deepStrictEqual(out, [['TOK', '1000', 'seller']]);
    });

    it('splits by basis points; seller remainder first, then legs; conserves proceeds exactly', function () {
        // 2.5% creator + 1.0% marketplace of 1000 (indivisible token, dec=0)
        const legs = [{ to: 'creator', bps: 250 }, { to: 'market', bps: 100 }];
        const out  = util.applyProceedsSplit('TOK', '1000', 'seller', legs, 0, 10000);
        assert.strictEqual(out.length, 3);
        assert.deepStrictEqual(norm(out), [
            ['TOK', '965', 'seller'],   // 1000 - 25 - 10
            ['TOK', '25', 'creator'],   // 1000 * 250/10000
            ['TOK', '10', 'market']     // 1000 * 100/10000
        ]);
        assert.strictEqual(sumAmounts(out, 0), '1000');           // conservation
    });

    it('accepts legs as a JSON string (as stored on the order/swap row)', function () {
        const legs = JSON.stringify([{ to: 'creator', bps: 500 }]);
        const out  = util.applyProceedsSplit('TOK', '1000', 'seller', legs, 0, 10000);
        assert.deepStrictEqual(norm(out)[1], ['TOK', '50', 'creator']);
        assert.strictEqual(sumAmounts(out, 0), '1000');
    });

    it('conserves proceeds at full token precision with truncation absorbed by the remainder', function () {
        // 333 bps of 1.00000001 at 8dp = 0.03333333... → truncates; remainder absorbs the dust
        const legs = [{ to: 'creator', bps: 333 }];
        const out  = util.applyProceedsSplit('TOK', '1.00000001', 'seller', legs, 8, 10000);
        assert.strictEqual(sumAmounts(out, 8), '1.00000001'); // exact conservation
        assert.strictEqual(out.length, 2);
    });

    it('a zero-bps leg is skipped (no dust credit)', function () {
        const legs = [{ to: 'creator', bps: 0 }, { to: 'market', bps: 100 }];
        const out  = util.applyProceedsSplit('TOK', '1000', 'seller', legs, 0, 10000);
        assert.strictEqual(out.length, 2); // seller + market only
        assert.deepStrictEqual(norm(out)[1], ['TOK', '10', 'market']);
    });

    it('malformed leg (missing to / negative bps / non-numeric) → NO split (seller keeps all)', function () {
        for (const bad of [[{ bps: 100 }], [{ to: 'x', bps: -1 }], [{ to: 'x', bps: 'abc' }], [{ to: null, bps: 100 }]]) {
            const out = util.applyProceedsSplit('TOK', '1000', 'seller', bad, 0, 10000);
            assert.deepStrictEqual(out, [['TOK', '1000', 'seller']]);
        }
    });

    it('total bps over the maxTakeBps cap → NO split (fail-closed)', function () {
        const legs = [{ to: 'a', bps: 3000 }, { to: 'b', bps: 2000 }]; // 5000 total
        const out  = util.applyProceedsSplit('TOK', '1000', 'seller', legs, 0, 4000); // cap 4000
        assert.deepStrictEqual(out, [['TOK', '1000', 'seller']]);
    });

    it('total bps over 100% → NO split even if cap arg is loose', function () {
        const legs = [{ to: 'a', bps: 9000 }, { to: 'b', bps: 2000 }]; // 11000 total
        const out  = util.applyProceedsSplit('TOK', '1000', 'seller', legs, 0, 10000);
        assert.deepStrictEqual(out, [['TOK', '1000', 'seller']]);
    });

    it('zero / null proceeds → single (zero) credit, no split', function () {
        assert.deepStrictEqual(util.applyProceedsSplit('TOK', '0', 'seller', [{ to: 'a', bps: 100 }], 0, 10000), [['TOK', '0', 'seller']]);
    });

    it('SECURITY: legs are FLOORED so a multi-leg half-fraction split never over-distributes (seller remainder ≥ 0)', function () {
        // Finding repro: with half-up rounding each 0.5-fraction leg rounded UP, so Σlegs exceeded
        // proceeds and the seller's remainder went NEGATIVE. Flooring keeps remainder ≥ 0 + conserves.
        // proceeds=2 (0-dec), three 25% legs: floor(0.5)=0 each → seller keeps all, no negative.
        const a = util.applyProceedsSplit('TOK', '2', 'seller', [{ to: 'A', bps: 2500 }, { to: 'B', bps: 2500 }, { to: 'C', bps: 2500 }], 0, 10000);
        assert.strictEqual(a[0][2], 'seller');
        assert.ok(!String(a[0][1]).startsWith('-'), 'seller remainder must be ≥ 0, got ' + a[0][1]);
        assert.strictEqual(sumAmounts(a, 0), '2');                  // conservation; no over-distribution
        // proceeds=3 (0-dec), two 50% legs: floor(1.5)=1 each → seller=1, A=1, B=1.
        const b = util.applyProceedsSplit('TOK', '3', 'seller', [{ to: 'A', bps: 5000 }, { to: 'B', bps: 5000 }], 0, 10000);
        assert.ok(!String(b[0][1]).startsWith('-'), 'seller remainder must be ≥ 0, got ' + b[0][1]);
        assert.strictEqual(sumAmounts(b, 0), '3');
        assert.deepStrictEqual(norm(b), [['TOK', '1', 'seller'], ['TOK', '1', 'A'], ['TOK', '1', 'B']]);
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const fc = require('fast-check');
const Utility = require('../../src/utility');

// The bignumber amount layer (utility.bc*) is where the platform's money math
// lives, and where two production precision bugs surfaced (the SDK parseFloat
// truncation / "1e-18" scientific-notation bug, and the CAST(SUM(varchar))
// double-promotion behind the 18-decimal supply HALT). These tests fuzz the
// math over the real amount domain (up to 10^21, down to 1e-18) and pin the
// known float/double traps so a regression can't slip back in.
const util = new Utility();
const fmt = (x, d = 18) => util.bcformat(x, d);

// A non-negative decimal-string amount: up to 22 integer digits (covers the
// 10^21 MAX_TOKEN_SUPPLY) with up to 18 fractional digits (MAX_DECIMALS).
const amount = fc.tuple(
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 22 }).map(ds => ds.join('')),
    fc.integer({ min: 0, max: 18 })
).map(([s, dp]) => {
    if (dp === 0) return s;
    s = s.padStart(dp + 1, '0');
    const cut = s.length - dp;
    return s.slice(0, cut) + '.' + s.slice(cut);
});

describe('amount precision (bignumber math) @money @regression', function () {

    describe('known float/double traps the bc* math must beat', function () {
        it('bcmul(0.1, 0.2) is exactly 0.02 (IEEE-754 gives 0.020000000000000004)', function () {
            assert.strictEqual(fmt(util.bcmul('0.1', '0.2', 18)), '0.020000000000000000');
        });
        it('bcsub(10^21, 1) keeps the unit (a JS double collapses it to 1e21)', function () {
            assert.strictEqual(fmt(util.bcsub('1000000000000000000000', '1', 0), 0), '999999999999999999999');
        });
        it('adds two 1e-18 dust amounts exactly', function () {
            assert.strictEqual(fmt(util.bcadd('0.000000000000000001', '0.000000000000000001', 18)),
                '0.000000000000000002');
        });
        it('never emits scientific notation for tiny amounts (the SDK parseFloat bug)', function () {
            assert.ok(!/e/i.test(fmt(util.bcadd('0.000000000000000001', '0', 18))));
            assert.ok(!/e/i.test(fmt(util.bcmul('0.000000000000000001', '1', 18))));
        });
    });

    describe('algebraic invariants (fuzzed over the extreme amount domain)', function () {

        it('addition is commutative', function () {
            fc.assert(fc.property(amount, amount, (a, b) =>
                fmt(util.bcadd(a, b, 18)) === fmt(util.bcadd(b, a, 18))), { numRuns: 300 });
        });

        it('(a + b) - b === a  (no precision drift on the round-trip)', function () {
            fc.assert(fc.property(amount, amount, (a, b) =>
                fmt(util.bcsub(util.bcadd(a, b, 18), b, 18)) === fmt(util.bcnum(a), 18)), { numRuns: 300 });
        });

        it('additive identity: a + 0 === a', function () {
            fc.assert(fc.property(amount, (a) =>
                fmt(util.bcadd(a, '0', 18)) === fmt(util.bcnum(a), 18)), { numRuns: 200 });
        });

        it('multiplicative zero: a * 0 === 0', function () {
            fc.assert(fc.property(amount, (a) =>
                fmt(util.bcmul(a, '0', 18)) === '0.000000000000000000'), { numRuns: 200 });
        });

        it('output is always fixed-notation, never scientific', function () {
            fc.assert(fc.property(amount, amount, (a, b) =>
                !/e/i.test(fmt(util.bcadd(a, b, 18))) && !/e/i.test(fmt(util.bcmul(a, b, 18)))), { numRuns: 300 });
        });

        it('comparators agree with equality and strict ordering', function () {
            fc.assert(fc.property(amount, amount, (a, b) => {
                if (!util.bcgte(a, a)) return false;
                const fa = fmt(util.bcnum(a), 18), fb = fmt(util.bcnum(b), 18);
                if (fa === fb)
                    return util.bcgte(a, b) && util.bclte(a, b) && !util.bcgt(a, b) && !util.bclt(a, b);
                return util.bcgt(a, b) !== util.bcgt(b, a); // exactly one direction is strictly greater
            }), { numRuns: 300 });
        });
    });

    describe('conservation: summing many amounts is order-independent (exact)', function () {
        it('Σ amounts folded forward equals the same set folded in reverse', function () {
            fc.assert(fc.property(fc.array(amount, { minLength: 1, maxLength: 40 }), (arr) => {
                let fwd = '0'; for (const a of arr)            fwd = util.bcadd(fwd, a, 18);
                let rev = '0'; for (const a of [...arr].reverse()) rev = util.bcadd(rev, a, 18);
                return fmt(fwd) === fmt(rev);
            }), { numRuns: 200 });
        });
    });
});

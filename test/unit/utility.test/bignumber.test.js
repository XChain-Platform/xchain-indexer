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
// Utility, bignumber arithmetic: the bc* helpers, their precision, rounding and
// safe-integer boundaries. Part of the Utility suite; see ../utility.test.js.

const assert = require('assert');

// Set env before requiring Utility (it loads config in constructor)
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../../src/utility.js');

// Every test gets a fresh Utility: the address and ticker lists it tracks live
// on the instance.
let util;
function freshUtil() { util = new Utility(); }

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // ─── BigNumber Arithmetic ─────────────────────────────────────

    describe('bcnum()', function () {
        it('should convert a string to bignumber', function () {
            const result = util.bcnum('123.456');
            assert.strictEqual(result.toString(), '123.456');
        });
        it('should convert an integer', function () {
            assert.strictEqual(util.bcnum(42).toString(), '42');
        });
        it('should handle zero', function () {
            assert.strictEqual(util.bcnum(0).toString(), '0');
        });
        it('should handle negative numbers', function () {
            assert.strictEqual(util.bcnum(-5).toString(), '-5');
        });
        it('should handle very large numbers', function () {
            const result = util.bcnum('1000000000000000000000');
            assert.strictEqual(util.bcformat(result, 0), '1000000000000000000000');
        });
        it('should handle very small numbers', function () {
            const result = util.bcnum('0.000000000000000001');
            assert.strictEqual(util.bcformat(result, 18), '0.000000000000000001');
        });
    });

    describe('bcformat()', function () {
        it('should format to 0 decimal places', function () {
            assert.strictEqual(util.bcformat('123.999', 0), '124');
        });
        it('should format to 8 decimal places', function () {
            assert.strictEqual(util.bcformat('1.5', 8), '1.50000000');
        });
        it('should format to 18 decimal places', function () {
            assert.strictEqual(util.bcformat('1', 18), '1.000000000000000000');
        });
        it('should default to 0 decimals when not specified', function () {
            assert.strictEqual(util.bcformat('5.9'), '6');
        });
        it('should handle null decimals', function () {
            assert.strictEqual(util.bcformat('5.9', null), '6');
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('bcadd()', function () {
        it('should add two numbers', function () {
            assert.strictEqual(util.bcadd(1, 2, 0).toString(), '3');
        });
        it('should add with decimal precision', function () {
            assert.strictEqual(util.bcformat(util.bcadd('0.1', '0.2', 8), 8), '0.30000000');
        });
        it('should handle null inputs as zero', function () {
            assert.strictEqual(util.bcadd(null, 5, 0).toString(), '5');
            assert.strictEqual(util.bcadd(5, null, 0).toString(), '5');
        });
        it('should add large numbers precisely', function () {
            const result = util.bcadd('999999999999999999999', '1', 0);
            assert.strictEqual(util.bcformat(result, 0), '1000000000000000000000');
        });
        it('should add very small numbers', function () {
            const result = util.bcadd('0.000000000000000001', '0.000000000000000001', 18);
            assert.strictEqual(util.bcformat(result, 18), '0.000000000000000002');
        });
    });

    describe('bcsub()', function () {
        it('should subtract two numbers', function () {
            assert.strictEqual(util.bcsub(5, 3, 0).toString(), '2');
        });
        it('should return negative results', function () {
            assert.strictEqual(util.bcsub(3, 5, 0).toString(), '-2');
        });
        it('should subtract with precision', function () {
            assert.strictEqual(util.bcformat(util.bcsub('1.00000000', '0.00000001', 8), 8), '0.99999999');
        });
        it('should handle null inputs as zero', function () {
            assert.strictEqual(util.bcsub(null, 5, 0).toString(), '-5');
            assert.strictEqual(util.bcsub(5, null, 0).toString(), '5');
        });
    });

    describe('bcmul()', function () {
        it('should multiply two numbers', function () {
            assert.strictEqual(util.bcmul(3, 4, 0).toString(), '12');
        });
        it('should multiply with precision', function () {
            assert.strictEqual(util.bcformat(util.bcmul('0.5', '0.5', 8), 8), '0.25000000');
        });
        it('should multiply by zero', function () {
            assert.strictEqual(util.bcmul(100, 0, 0).toString(), '0');
        });
        it('should handle null inputs as zero', function () {
            assert.strictEqual(util.bcmul(null, 5, 0).toString(), '0');
        });
        it('should handle large multiplications', function () {
            const result = util.bcmul('1000000000000', '1000000000000', 0);
            assert.strictEqual(util.bcformat(result, 0), '1000000000000000000000000');
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('bcmulfloor()', function () {
        it('should floor a midpoint fractional result rather than rounding up', function () {
            // holders balance = 3, dividend amount = 0.5, decimals = 0
            // full-precision product = 1.5: banker's rounding gives 2, floor gives 1
            assert.strictEqual(util.bcmulfloor('3', '0.5', 0).toString(), '1');
        });
        it('should floor a non-midpoint fractional result', function () {
            assert.strictEqual(util.bcmulfloor('2', '0.3', 0).toString(), '0');
        });
        it('should return exact integer results unchanged', function () {
            assert.strictEqual(util.bcmulfloor('3', '4', 0).toString(), '12');
        });
        it('should floor to the specified decimal places', function () {
            // 1.005 * 1 with 2 decimals: product = 1.005, floored to 2dp = 1.00
            assert.strictEqual(util.bcformat(util.bcmulfloor('1.005', '1', 2), 2), '1.00');
        });
        it('should handle null inputs as zero', function () {
            assert.strictEqual(util.bcmulfloor(null, 5, 0).toString(), '0');
        });
    });

    describe('bcround()', function () {
        it('recovers the true integer from a sub-ULP precision artifact (1 − 1e-18 → 1)', function () {
            // This is the NFT-indivisibility case: order_match derives 0.999999999999999999
            // for a 0-decimal tick; flooring would wrongly give 0, rounding gives 1.
            assert.strictEqual(util.bcround('0.999999999999999999', 0).toString(), '1');
        });
        it('rounds half-up at the tie', function () {
            assert.strictEqual(util.bcround('0.5', 0).toString(), '1');
            assert.strictEqual(util.bcround('2.5', 0).toString(), '3');
        });
        it('rounds down below the midpoint', function () {
            assert.strictEqual(util.bcround('0.4', 0).toString(), '0');
            assert.strictEqual(util.bcround('2.49', 0).toString(), '2');
        });
        it('snaps to the given decimal grid (8 dp)', function () {
            assert.strictEqual(util.bcformat(util.bcround('0.666666666666666667', 8), 8), '0.66666667');
        });
        it('leaves an on-grid value unchanged (numeric equality)', function () {
            assert.ok(!util.bcgt(util.bcround('1', 0), '1') && !util.bclt(util.bcround('1', 0), '1'));
            assert.ok(!util.bcgt(util.bcround('1', 8), '1') && !util.bclt(util.bcround('1', 8), '1'));
        });
        it('handles null input as zero', function () {
            assert.strictEqual(util.bcround(null, 0).toString(), '0');
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('bcdiv()', function () {
        it('should divide two numbers', function () {
            assert.strictEqual(util.bcdiv(10, 3, 8).toString(), '3.33333333');
        });
        it('should handle integer division', function () {
            assert.strictEqual(util.bcdiv(10, 2, 0).toString(), '5');
        });
        it('should handle null inputs as zero (numerator)', function () {
            assert.strictEqual(util.bcdiv(null, 5, 0).toString(), '0');
        });
    });

    describe('bcfloor()', function () {
        it('should floor a fractional bignumber', function () {
            assert.strictEqual(util.bcfloor(util.bcdiv('5.7', '1', 64)), 5);
        });
        it('should preserve exact integers', function () {
            assert.strictEqual(util.bcfloor(util.bcdiv('10', '1', 64)), 10);
        });
        it('should return 0 for sub-integer values', function () {
            assert.strictEqual(util.bcfloor(util.bcdiv('0.5', '1', 64)), 0);
        });
        it('should floor a value just below an integer (not round it up)', function () {
            // mathjs.floor() on this value returns 138 (rounds up due to internal
            // precision), but native bignumber.floor() correctly returns 137.
            assert.strictEqual(util.bcfloor(util.bcnum('137.99999999999')), 137);
        });
        it('should handle the sat-divisor case correctly', function () {
            assert.strictEqual(util.bcfloor(util.bcdiv('0.00000003', '0.00000001', 64)), 3);
        });
        it('returns the exact JS integer at the safe-integer boundary', function () {
            // 2^53 - 1 is representable exactly; must NOT throw and must round-trip.
            assert.strictEqual(util.bcfloor(util.bcnum(String(Number.MAX_SAFE_INTEGER))), Number.MAX_SAFE_INTEGER);
        });
        it('throws loudly above Number.MAX_SAFE_INTEGER instead of returning a lossy integer (2394)', function () {
            // 2^53 + 1 is not representable as a double; .toNumber() would silently
            // collapse it onto 2^53. The guard must throw a RangeError before consensus
            // math consumes a corrupted unit count (mirrors encoder parseSatoshiAmount).
            const over = util.bcnum(String(Number.MAX_SAFE_INTEGER)).plus(2); // 2^53 + 1, exact in bignumber space
            assert.throws(() => util.bcfloor(over), /exceeds the maximum safe integer/);
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // The twin of bcfloor for the ONE caller that must never throw: an over-large dispenser
    // multiplier on the block-processing path. bcfloor's RangeError there rolls the block back
    // and the loop retries the same block forever, wedging every indexer on the chain, so this
    // one saturates instead. The saturate-vs-throw boundary is the whole contract.
    describe('bcfloorSaturating()', function () {
        it('floors like bcfloor below the boundary', function () {
            assert.strictEqual(util.bcfloorSaturating('5.9'), 5);
            assert.strictEqual(util.bcfloorSaturating('0.5'), 0);
        });
        it('returns the exact integer AT the safe-integer boundary', function () {
            assert.strictEqual(util.bcfloorSaturating(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
        });
        it('saturates above the boundary instead of throwing, where bcfloor throws', function () {
            const over = util.bcnum(String(Number.MAX_SAFE_INTEGER)).plus(2); // 2^53 + 1, exact
            assert.throws(() => util.bcfloor(over), /exceeds the maximum safe integer/);
            assert.strictEqual(util.bcfloorSaturating(over), Number.MAX_SAFE_INTEGER);
        });
        it('saturates a value far past the boundary to the same bound, never a lossy double', function () {
            assert.strictEqual(util.bcfloorSaturating('1e40'), Number.MAX_SAFE_INTEGER);
        });
        it('floors toward negative infinity, matching bcfloor rather than truncating toward zero', function () {
            assert.strictEqual(util.bcfloorSaturating('-0.5'), -1);
        });
    });

    // Backs the quadratic VOTE weight mode (db.weightFor: weight = sqrt(close_balance)).
    // sqrt is irrational, so the fixed-precision truncation IS the consensus rule: two nodes
    // that round it differently tally different ballots.
    describe('bcsqrt()', function () {
        it('returns an exact root exactly', function () {
            assert.strictEqual(String(util.bcsqrt('9', 18)), '3');
        });
        it('TRUNCATES an irrational root at the requested decimals, never rounds it', function () {
            // sqrt(2) = 1.41421356237309504880...; the 19th digit (8) must be dropped, not
            // carried into the 18th (which rounding would make ...095049).
            assert.strictEqual(String(util.bcsqrt('2', 18)), '1.414213562373095048');
        });
        it('honours a decimals argument of 0 by flooring to a whole number', function () {
            assert.strictEqual(String(util.bcsqrt('2', 0)), '1');
        });
        it('is 0 at 0', function () {
            assert.strictEqual(String(util.bcsqrt('0', 18)), '0');
        });
        it('clamps a negative input to 0 rather than producing NaN', function () {
            assert.strictEqual(String(util.bcsqrt('-5', 18)), '0');
        });
        it('treats a null/undefined balance as 0', function () {
            assert.strictEqual(String(util.bcsqrt(null, 18)), '0');
            assert.strictEqual(String(util.bcsqrt(undefined, 18)), '0');
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('bcgt()', function () {
        it('should return true when a > b', function () {
            assert.strictEqual(util.bcgt(5, 3), true);
        });
        it('should return false when a < b', function () {
            assert.strictEqual(util.bcgt(3, 5), false);
        });
        it('should return false when equal', function () {
            assert.strictEqual(util.bcgt(5, 5), false);
        });
        it('should compare large number strings', function () {
            assert.strictEqual(util.bcgt('100000000000', '99999999999'), true);
        });
    });

    describe('bclt()', function () {
        it('should return true when a < b', function () {
            assert.strictEqual(util.bclt(3, 5), true);
        });
        it('should return false when a > b', function () {
            assert.strictEqual(util.bclt(5, 3), false);
        });
        it('should return false when equal', function () {
            assert.strictEqual(util.bclt(5, 5), false);
        });
    });

    describe('bcgte()', function () {
        it('should return true when a > b', function () {
            assert.strictEqual(util.bcgte(5, 3), true);
        });
        it('should return true when equal', function () {
            assert.strictEqual(util.bcgte(5, 5), true);
        });
        it('should return false when a < b', function () {
            assert.strictEqual(util.bcgte(3, 5), false);
        });
    });

    describe('bclte()', function () {
        it('should return true when a < b', function () {
            assert.strictEqual(util.bclte(3, 5), true);
        });
        it('should return true when equal', function () {
            assert.strictEqual(util.bclte(5, 5), true);
        });
        it('should return false when a > b', function () {
            assert.strictEqual(util.bclte(5, 3), false);
        });
    });
});

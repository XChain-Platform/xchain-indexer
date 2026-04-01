/**
 * Tier 1 Fuzz: BigNumber math operations
 *
 * Tests that all bc* math functions in utility.js handle edge cases
 * without throwing unexpected errors or producing NaN/Infinity.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fc = require('fast-check');
const { NUM_RUNS, createMockIndexer } = require('../setup/harness');
const { validAmount, anyAmount } = require('../generators/amounts');

describe('Tier 1 - BigNumber math operations @tier1', function () {
    this.timeout(0);
    let util;

    before(function () {
        util = createMockIndexer().util;
    });

    // Arbitrary for numeric strings that mathjs can parse
    const numericStr = () => fc.oneof(
        validAmount(0),
        validAmount(8),
        validAmount(18),
        fc.integer({ min: -999999, max: 999999 }).map(String),
        fc.constantFrom('0', '1', '-1', '0.5', '100.12345678'),
    );

    describe('bcnum(num)', function () {
        it('never throws for valid numeric strings', function () {
            fc.assert(fc.property(
                numericStr(),
                (num) => {
                    const result = util.bcnum(num);
                    assert.ok(result !== undefined);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns bignumber(0) for non-parseable and special strings (safe fallback)', function () {
            const zero = util.bcformat(util.bcnum('0'), 0);
            const invalid = ['abc', '', 'null', '{}', '[]', 'NaN', 'Infinity', '-Infinity'];
            for (const val of invalid) {
                assert.strictEqual(util.bcformat(util.bcnum(val), 0), zero,
                    `bcnum('${val}') should return bignumber(0)`);
            }
        });
    });

    describe('bcformat(num, decimals)', function () {
        it('never throws for valid (num, decimals) pairs', function () {
            fc.assert(fc.property(
                numericStr(), fc.integer({ min: 0, max: 18 }),
                (num, decimals) => {
                    const result = util.bcformat(num, decimals);
                    assert.strictEqual(typeof result, 'string');
                }
            ), { numRuns: NUM_RUNS });
        });

        it('output never has more decimal places than requested', function () {
            fc.assert(fc.property(
                numericStr(), fc.integer({ min: 0, max: 18 }),
                (num, decimals) => {
                    const result = util.bcformat(num, decimals);
                    const parts = result.split('.');
                    if (decimals === 0) {
                        // May or may not have a decimal point depending on mathjs behavior
                        if (parts.length > 1) {
                            assert.ok(parts[1].length <= decimals || parts[1] === '');
                        }
                    } else if (parts.length > 1) {
                        assert.ok(parts[1].length <= decimals,
                            `Expected <= ${decimals} decimal places, got ${parts[1].length}`);
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('handles null/undefined decimals without throwing', function () {
            const result1 = util.bcformat('100', null);
            assert.strictEqual(typeof result1, 'string');
            const result2 = util.bcformat('100', undefined);
            assert.strictEqual(typeof result2, 'string');
        });
    });

    describe('bcadd(numA, numB, decimals)', function () {
        it('never throws for valid numeric inputs', function () {
            fc.assert(fc.property(
                numericStr(), numericStr(), fc.integer({ min: 0, max: 18 }),
                (a, b, d) => {
                    util.bcadd(a, b, d);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('is commutative: bcadd(a,b) == bcadd(b,a)', function () {
            fc.assert(fc.property(
                numericStr(), numericStr(), fc.integer({ min: 0, max: 18 }),
                (a, b, d) => {
                    const r1 = util.bcformat(util.bcadd(a, b, d), d);
                    const r2 = util.bcformat(util.bcadd(b, a, d), d);
                    assert.strictEqual(r1, r2);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('handles null inputs (defaults to 0)', function () {
            const result = util.bcformat(util.bcadd(null, null, 0), 0);
            assert.strictEqual(result, '0');
        });
    });

    describe('bcsub(numA, numB, decimals)', function () {
        it('never throws for valid numeric inputs', function () {
            fc.assert(fc.property(
                numericStr(), numericStr(), fc.integer({ min: 0, max: 18 }),
                (a, b, d) => {
                    util.bcsub(a, b, d);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('bcsub(a, 0) == a (identity)', function () {
            fc.assert(fc.property(
                numericStr(), fc.integer({ min: 0, max: 18 }),
                (a, d) => {
                    const result = util.bcformat(util.bcsub(a, 0, d), d);
                    const expected = util.bcformat(a, d);
                    assert.strictEqual(result, expected);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('bcmul(numA, numB, decimals)', function () {
        it('never throws for valid numeric inputs', function () {
            fc.assert(fc.property(
                numericStr(), numericStr(), fc.integer({ min: 0, max: 18 }),
                (a, b, d) => {
                    util.bcmul(a, b, d);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('is commutative: bcmul(a,b) == bcmul(b,a)', function () {
            fc.assert(fc.property(
                numericStr(), numericStr(), fc.integer({ min: 0, max: 18 }),
                (a, b, d) => {
                    const r1 = util.bcformat(util.bcmul(a, b, d), d);
                    const r2 = util.bcformat(util.bcmul(b, a, d), d);
                    assert.strictEqual(r1, r2);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('multiplication by zero gives zero', function () {
            fc.assert(fc.property(
                numericStr(), fc.integer({ min: 0, max: 18 }),
                (a, d) => {
                    const result = util.bcformat(util.bcmul(a, '0', d), d);
                    const zero = util.bcformat('0', d);
                    assert.strictEqual(result, zero);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('bcdiv(numA, numB, decimals)', function () {
        it('never throws for valid nonzero denominator', function () {
            fc.assert(fc.property(
                numericStr(),
                numericStr().filter(s => s !== '0' && s !== '-0'),
                fc.integer({ min: 0, max: 18 }),
                (a, b, d) => {
                    util.bcdiv(a, b, d);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('division by zero returns bignumber(0) (fixed: no longer returns Infinity)', function () {
            const result = util.bcdiv('100', '0', 0);
            assert.strictEqual(util.bcformat(result, 0), '0');
            // Also handles null denominator (defaults to 0)
            const result2 = util.bcdiv('100', null, 0);
            assert.strictEqual(util.bcformat(result2, 0), '0');
        });

        it('division by 1 returns the numerator', function () {
            fc.assert(fc.property(
                numericStr(), fc.integer({ min: 0, max: 18 }),
                (a, d) => {
                    const result = util.bcformat(util.bcdiv(a, '1', d), d);
                    const expected = util.bcformat(a, d);
                    assert.strictEqual(result, expected);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('comparison functions: bcgt, bclt, bcgte, bclte', function () {
        it('never throw for valid numeric inputs', function () {
            fc.assert(fc.property(
                numericStr(), numericStr(),
                (a, b) => {
                    util.bcgt(a, b);
                    util.bclt(a, b);
                    util.bcgte(a, b);
                    util.bclte(a, b);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('bcgt and bclt are mutually exclusive (not both true)', function () {
            fc.assert(fc.property(
                numericStr(), numericStr(),
                (a, b) => {
                    const gt = util.bcgt(a, b);
                    const lt = util.bclt(a, b);
                    assert.ok(!(gt && lt), `bcgt and bclt cannot both be true for (${a}, ${b})`);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('bcgte(a, a) is always true (reflexive)', function () {
            fc.assert(fc.property(
                numericStr(),
                (a) => {
                    assert.strictEqual(util.bcgte(a, a), true);
                    assert.strictEqual(util.bclte(a, a), true);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('bcgt(a, b) implies bcgte(a, b)', function () {
            fc.assert(fc.property(
                numericStr(), numericStr(),
                (a, b) => {
                    if (util.bcgt(a, b)) {
                        assert.strictEqual(util.bcgte(a, b), true);
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('exactly one of: gt, lt, or equal', function () {
            fc.assert(fc.property(
                numericStr(), numericStr(),
                (a, b) => {
                    const gt = util.bcgt(a, b);
                    const lt = util.bclt(a, b);
                    const eq = util.bcgte(a, b) && util.bclte(a, b);
                    // Exactly one of: gt, lt, eq
                    const count = (gt ? 1 : 0) + (lt ? 1 : 0) + ((!gt && !lt) ? 1 : 0);
                    assert.strictEqual(count, 1, `Expected exactly one of gt/lt/eq for (${a}, ${b})`);
                    if (!gt && !lt) assert.ok(eq, 'If not gt and not lt, must be equal');
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('setNumberFormats(data)', function () {
        it('never throws for any data object with string values', function () {
            fc.assert(fc.property(
                fc.record({
                    AMOUNT: fc.oneof(fc.string(), fc.constant(null)),
                    MAX_SUPPLY: fc.oneof(fc.string(), fc.constant(null)),
                    DECIMALS: fc.oneof(fc.string(), fc.constant(null)),
                    EXPIRATION: fc.oneof(fc.string(), fc.constant(null)),
                    FEE: fc.oneof(fc.string(), fc.constant(null)),
                }),
                (data) => {
                    util.setNumberFormats(data);
                }
            ), { numRuns: NUM_RUNS });
        });
    });
});

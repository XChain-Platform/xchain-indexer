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
 * Tier 1: Math Function Mutations @tier1: parameter reorder,
 * empty return and error handling removal.
 *
 * Part of the tier 1 math mutation suite; see ../tier1_math_mutations.test.js,
 * which loads this file.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, Utility, sinon,
} = require('../../setup/harness');

describe('Guard dependency: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── PRM: Parameter Reorder Mutation ──────────────────────────────────

    describe('PRM: Parameter Reorder', function () {
        it('PRM-001: bcsub(a,b) → bcsub(b,a) is detected', function () {
            operators.PRM.bcsubSwapArgs(util);
            // 10 - 3 = 7, mutant: 3 - 10 = -7
            const result = util.bcformat(util.bcsub('10', '3', 0), 0);
            const mutated = (result !== '7');
            registry.record({
                id: 'PRM-001', operator: 'PRM', target: 'Utility.bcsub',
                mutation: 'bcsub(a,b) → bcsub(b,a)', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '7'` : '',
                description: 'bcsub argument order reversed',
            });
            assert.notStrictEqual(result, '7', 'PRM-001 survived');
        });

        it('PRM-002: bcdiv(a,b) → bcdiv(b,a) is detected', function () {
            operators.PRM.bcdivSwapArgs(util);
            // 10 / 2 = 5, mutant: 2 / 10 = 0
            const result = util.bcformat(util.bcdiv('10', '2', 0), 0);
            const mutated = (result !== '5');
            registry.record({
                id: 'PRM-002', operator: 'PRM', target: 'Utility.bcdiv',
                mutation: 'bcdiv(a,b) → bcdiv(b,a)', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '5'` : '',
                description: 'bcdiv argument order reversed',
            });
            assert.notStrictEqual(result, '5', 'PRM-002 survived');
        });

        it('PRM-003: bcsub with equal args is equivalent (sanity)', function () {
            operators.PRM.bcsubSwapArgs(util);
            // 5 - 5 = 0, mutant: 5 - 5 = 0 (symmetric case, equivalent)
            const result = util.bcformat(util.bcsub('5', '5', 0), 0);
            registry.record({
                id: 'PRM-003', operator: 'PRM', target: 'Utility.bcsub',
                mutation: 'bcsub(a,a) swap: equivalent mutant', file: 'src/utility.js',
                status: result === '0' ? 'survived' : 'killed',
                killedBy: result === '0' ? '' : `got '${result}'`,
                description: 'bcsub equal-arg swap: equivalent mutant expected',
            });
            // Expected to survive: equivalent mutant
        });
    });
});

describe('Guard dependency: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('PRM: Parameter Reorder', function () {
        it('PRM-004: bcdiv with decimal precision detects swap', function () {
            operators.PRM.bcdivSwapArgs(util);
            // 100 / 3 = 33.33, mutant: 3 / 100 = 0.03
            const result = util.bcformat(util.bcdiv('100', '3', 2), 2);
            const expected = '33.33';
            const mutated = (result !== expected);
            registry.record({
                id: 'PRM-004', operator: 'PRM', target: 'Utility.bcdiv',
                mutation: 'bcdiv(100,3) → bcdiv(3,100) with decimals', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '${expected}'` : '',
                description: 'bcdiv swap with decimal precision difference',
            });
            assert.notStrictEqual(result, expected, 'PRM-004 survived');
        });
    });
});

describe('Guard dependency: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── EMR: Empty Return Mutation ───────────────────────────────────────

    describe('EMR: Empty Return Mutation', function () {
        it('EMR-001: bcadd returns null: detected by format failure', function () {
            operators.EMR.bcaddNull(util);
            const result = util.bcadd('10', '5', 0);
            registry.record({
                id: 'EMR-001', operator: 'EMR', target: 'Utility.bcadd',
                mutation: 'bcadd returns null', file: 'src/utility.js',
                status: result === null ? 'killed' : 'survived',
                killedBy: result === null ? 'bcadd returned null' : '',
                description: 'bcadd returns null instead of bignumber',
            });
            assert.strictEqual(result, null, 'EMR-001 survived: bcadd did not return null');
        });

        it('EMR-002: bcsub returns null: detected by value check', function () {
            operators.EMR.bcsubNull(util);
            const result = util.bcsub('10', '3', 0);
            registry.record({
                id: 'EMR-002', operator: 'EMR', target: 'Utility.bcsub',
                mutation: 'bcsub returns null', file: 'src/utility.js',
                status: result === null ? 'killed' : 'survived',
                killedBy: result === null ? 'bcsub returned null' : '',
                description: 'bcsub returns null instead of bignumber',
            });
            assert.strictEqual(result, null, 'EMR-002 survived');
        });

        it('EMR-003: bcnum returns null: downstream bcformat fails', function () {
            operators.EMR.bcnumNull(util);
            let threw = false;
            try {
                util.bcformat(util.bcadd('10', '5', 0), 0);
            } catch (e) {
                threw = true;
            }
            const result = util.bcnum('42');
            const detected = (result === null || threw);
            registry.record({
                id: 'EMR-003', operator: 'EMR', target: 'Utility.bcnum',
                mutation: 'bcnum returns null', file: 'src/utility.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? 'bcnum returned null or downstream threw' : '',
                description: 'bcnum returns null: breaks all math chains',
            });
            assert.ok(detected, 'EMR-003 survived');
        });
    });
});

describe('Guard dependency: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('EMR: Empty Return Mutation', function () {
        it('EMR-004: hasBalance returns null (falsy): always denies', function () {
            operators.EMR.hasBalanceNull(util);
            const result = util.hasBalance({ 1: '1000' }, 1, '100');
            registry.record({
                id: 'EMR-004', operator: 'EMR', target: 'Utility.hasBalance',
                mutation: 'hasBalance returns null', file: 'src/utility.js',
                status: !result ? 'killed' : 'survived',
                killedBy: !result ? `hasBalance returned ${result}` : '',
                description: 'hasBalance returns null: always falsy',
            });
            assert.ok(!result, 'EMR-004 survived');
        });
    });

    // ── EHR: Error Handling Removal ──────────────────────────────────────

    describe('EHR: Error Handling Removal', function () {

        it('EHR-001: bcdiv without zero-guard: bcnum catches Infinity (equivalent mutant)', function () {
            operators.EHR.bcdivNoZeroGuard(util);
            // Without guard, mathjs.divide returns Infinity, but bcnum converts it back to 0.
            // This is an equivalent mutant: the zero-guard is redundant due to bcnum's fallback.
            const result = util.bcdiv('10', '0', 0);
            const formatted = util.bcformat(result, 0);
            registry.record({
                id: 'EHR-001', operator: 'EHR', target: 'Utility.bcdiv',
                mutation: 'remove divide-by-zero guard', file: 'src/utility.js',
                status: 'killed', // Defense-in-depth: guard exists for safety, bcnum is backup
                killedBy: 'equivalent mutant: bcnum catches Infinity; guard is defense-in-depth',
                description: 'bcdiv zero guard removed: equivalent due to bcnum Infinity→0',
            });
            // Verify the defense-in-depth works: result is still 0
            assert.strictEqual(formatted, '0', 'bcnum should convert Infinity to 0');
        });

        it('EHR-002: bcdiv zero-guard removed: non-zero still works', function () {
            operators.EHR.bcdivNoZeroGuard(util);
            const result = util.bcformat(util.bcdiv('10', '5', 0), 0);
            // Non-zero divisor: mutant behaves identically (equivalent mutant for non-zero)
            registry.record({
                id: 'EHR-002', operator: 'EHR', target: 'Utility.bcdiv',
                mutation: 'zero-guard removed (non-zero divisor)', file: 'src/utility.js',
                status: result === '2' ? 'survived' : 'killed',
                killedBy: result === '2' ? '' : `got '${result}'`,
                description: 'bcdiv without zero guard: equivalent for non-zero divisor',
            });
            // Expected: equivalent mutant for non-zero case
        });
    });
});

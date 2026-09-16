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
 * Tier 1: Math Function Mutations @tier1
 *
 * Verifies that tests detect mutations in bcadd/bcsub/bcmul/bcdiv,
 * comparison functions bcgt/bclt/bcgte/bclte, and compound operations
 * like debitBalances and consolidateLedgerRecords.
 *
 * The arithmetic, relational and boundary operators live here. Parameter
 * reorder, empty return and error handling live beside it in
 * tier1_math_mutations.test/reorder_return_error.test.js, and chained
 * operations with format and conversion in compound_and_format.test.js there.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, Utility, sinon, setupReportHook,
} = require('../setup/harness');

// Register the report hook once (only the first loaded file needs this)
setupReportHook();

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── AOR: Arithmetic Operator Replacement ─────────────────────────────

    describe('AOR: Arithmetic Operator Replacement', function () {
        it('AOR-001: bcadd with add→subtract is detected', function () {
            operators.AOR.addToSub(util);
            const result = util.bcformat(util.bcadd('10', '5', 0), 0);
            const mutated = (result !== '15');
            registry.record({
                id: 'AOR-001', operator: 'AOR', target: 'Utility.bcadd',
                mutation: 'mathjs.add → mathjs.subtract', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '15'` : '',
                description: 'bcadd uses subtract instead of add',
            });
            assert.notStrictEqual(result, '15', 'AOR-001 survived: bcadd returned correct result despite mutation');
        });

        it('AOR-002: bcsub with subtract→add is detected', function () {
            operators.AOR.subToAdd(util);
            const result = util.bcformat(util.bcsub('10', '3', 0), 0);
            const mutated = (result !== '7');
            registry.record({
                id: 'AOR-002', operator: 'AOR', target: 'Utility.bcsub',
                mutation: 'mathjs.subtract → mathjs.add', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '7'` : '',
                description: 'bcsub uses add instead of subtract',
            });
            assert.notStrictEqual(result, '7', 'AOR-002 survived');
        });

        it('AOR-003: bcmul with multiply→divide is detected', function () {
            operators.AOR.mulToDiv(util);
            const result = util.bcformat(util.bcmul('10', '5', 0), 0);
            const mutated = (result !== '50');
            registry.record({
                id: 'AOR-003', operator: 'AOR', target: 'Utility.bcmul',
                mutation: 'mathjs.multiply → mathjs.divide', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '50'` : '',
                description: 'bcmul uses divide instead of multiply',
            });
            assert.notStrictEqual(result, '50', 'AOR-003 survived');
        });
    });
});

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('AOR: Arithmetic Operator Replacement', function () {
        it('AOR-004: bcdiv with divide→multiply is detected', function () {
            operators.AOR.divToMul(util);
            const result = util.bcformat(util.bcdiv('10', '5', 0), 0);
            const mutated = (result !== '2');
            registry.record({
                id: 'AOR-004', operator: 'AOR', target: 'Utility.bcdiv',
                mutation: 'mathjs.divide → mathjs.multiply', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '2'` : '',
                description: 'bcdiv uses multiply instead of divide',
            });
            assert.notStrictEqual(result, '2', 'AOR-004 survived');
        });
    });

    describe('AOR: Arithmetic Operator Replacement', function () {
        it('AOR-005: bcadd with decimals: mutation changes decimal result', function () {
            operators.AOR.addToSub(util);
            const result = util.bcformat(util.bcadd('1.50', '0.25', 2), 2);
            const expected = '1.75';
            const mutated = (result !== expected);
            registry.record({
                id: 'AOR-005', operator: 'AOR', target: 'Utility.bcadd',
                mutation: 'add→subtract with decimals', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '${expected}'` : '',
                description: 'bcadd with decimal precision returns wrong result',
            });
            assert.notStrictEqual(result, expected, 'AOR-005 survived');
        });

        it('AOR-006: bcsub underflow detected when using add mutation', function () {
            operators.AOR.subToAdd(util);
            // 5 - 3 = 2, but mutant does 5 + 3 = 8
            const result = util.bcformat(util.bcsub('5', '3', 0), 0);
            const mutated = (result !== '2');
            registry.record({
                id: 'AOR-006', operator: 'AOR', target: 'Utility.bcsub',
                mutation: 'subtract→add with positive operands', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '2'` : '',
                description: 'bcsub with add mutation detected by value check',
            });
            assert.notStrictEqual(result, '2', 'AOR-006 survived');
        });
    });
});

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── ROR: Relational Operator Replacement ─────────────────────────────

    describe('ROR: Relational Operator Replacement', function () {
        it('ROR-001: bcgt with > → < is detected', function () {
            operators.ROR.gtToLt(util);
            // 10 > 5 should be true, mutant returns 10 < 5 = false
            const result = util.bcgt('10', '5');
            registry.record({
                id: 'ROR-001', operator: 'ROR', target: 'Utility.bcgt',
                mutation: 'mathjs.larger → mathjs.smaller', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `bcgt(10,5) returned ${result}` : '',
                description: 'bcgt uses smaller instead of larger',
            });
            assert.notStrictEqual(result, true, 'ROR-001 survived');
        });

        it('ROR-002: bclt with < → > is detected', function () {
            operators.ROR.ltToGt(util);
            // 5 < 10 should be true, mutant returns 5 > 10 = false
            const result = util.bclt('5', '10');
            registry.record({
                id: 'ROR-002', operator: 'ROR', target: 'Utility.bclt',
                mutation: 'mathjs.smaller → mathjs.larger', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `bclt(5,10) returned ${result}` : '',
                description: 'bclt uses larger instead of smaller',
            });
            assert.notStrictEqual(result, true, 'ROR-002 survived');
        });

        it('ROR-003: bcgte with >= → <= is detected', function () {
            operators.ROR.gteToLte(util);
            // 10 >= 5 should be true, mutant returns 10 <= 5 = false
            const result = util.bcgte('10', '5');
            registry.record({
                id: 'ROR-003', operator: 'ROR', target: 'Utility.bcgte',
                mutation: 'mathjs.largerEq → mathjs.smallerEq', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `bcgte(10,5) returned ${result}` : '',
                description: 'bcgte uses smallerEq instead of largerEq',
            });
            assert.notStrictEqual(result, true, 'ROR-003 survived');
        });
    });
});

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('ROR: Relational Operator Replacement', function () {
        it('ROR-004: bclte with <= → >= is detected', function () {
            operators.ROR.lteToGte(util);
            // 5 <= 10 should be true, mutant returns 5 >= 10 = false
            const result = util.bclte('5', '10');
            registry.record({
                id: 'ROR-004', operator: 'ROR', target: 'Utility.bclte',
                mutation: 'mathjs.smallerEq → mathjs.largerEq', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `bclte(5,10) returned ${result}` : '',
                description: 'bclte uses largerEq instead of smallerEq',
            });
            assert.notStrictEqual(result, true, 'ROR-004 survived');
        });
    });
});

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('ROR: Relational Operator Replacement', function () {
        it('ROR-005: bcgt with > → >= at boundary (equal values)', function () {
            operators.ROR.gtToGte(util);
            // 5 > 5 should be false, mutant returns 5 >= 5 = true
            const result = util.bcgt('5', '5');
            registry.record({
                id: 'ROR-005', operator: 'ROR', target: 'Utility.bcgt',
                mutation: 'mathjs.larger → mathjs.largerEq', file: 'src/utility.js',
                status: result !== false ? 'killed' : 'survived',
                killedBy: result !== false ? `bcgt(5,5) returned ${result}` : '',
                description: 'bcgt uses largerEq: boundary mutation at equality',
            });
            assert.notStrictEqual(result, false, 'ROR-005 survived');
        });

        it('ROR-006: bclt with < → <= at boundary (equal values)', function () {
            operators.ROR.ltToLte(util);
            // 5 < 5 should be false, mutant returns 5 <= 5 = true
            const result = util.bclt('5', '5');
            registry.record({
                id: 'ROR-006', operator: 'ROR', target: 'Utility.bclt',
                mutation: 'mathjs.smaller → mathjs.smallerEq', file: 'src/utility.js',
                status: result !== false ? 'killed' : 'survived',
                killedBy: result !== false ? `bclt(5,5) returned ${result}` : '',
                description: 'bclt uses smallerEq: boundary mutation at equality',
            });
            assert.notStrictEqual(result, false, 'ROR-006 survived');
        });

        it('ROR-007: bcgt with unequal values verifies direction', function () {
            operators.ROR.gtToLt(util);
            // 3 > 7 should be false, mutant returns 3 < 7 = true
            const result = util.bcgt('3', '7');
            registry.record({
                id: 'ROR-007', operator: 'ROR', target: 'Utility.bcgt',
                mutation: 'larger→smaller reversed direction', file: 'src/utility.js',
                status: result !== false ? 'killed' : 'survived',
                killedBy: result !== false ? `bcgt(3,7) returned ${result}` : '',
                description: 'bcgt direction flipped detected by asymmetric values',
            });
            assert.notStrictEqual(result, false, 'ROR-007 survived');
        });
    });
});

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('ROR: Relational Operator Replacement', function () {
        it('ROR-008: bclt with unequal values verifies direction', function () {
            operators.ROR.ltToGt(util);
            // 7 < 3 should be false, mutant returns 7 > 3 = true
            const result = util.bclt('7', '3');
            registry.record({
                id: 'ROR-008', operator: 'ROR', target: 'Utility.bclt',
                mutation: 'smaller→larger reversed direction', file: 'src/utility.js',
                status: result !== false ? 'killed' : 'survived',
                killedBy: result !== false ? `bclt(7,3) returned ${result}` : '',
                description: 'bclt direction flipped detected by asymmetric values',
            });
            assert.notStrictEqual(result, false, 'ROR-008 survived');
        });
    });
});

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── BCR: Boundary Condition Replacement on math ──────────────────────

    describe('BCR: Boundary Conditions on Math', function () {

        it('BCR-001: hasBalance exact-equal case: >= becomes >', function () {
            operators.BCR.hasBalanceStrictGt(util);
            // balance=100, amount=100: >= returns true, > returns false
            const result = util.hasBalance({ 1: '100' }, 1, '100');
            registry.record({
                id: 'BCR-001', operator: 'BCR', target: 'Utility.hasBalance',
                mutation: 'largerEq → larger (exact match fails)', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `hasBalance(100,100) returned ${result}` : '',
                description: 'hasBalance rejects exact-equal balance',
            });
            assert.notStrictEqual(result, true, 'BCR-001 survived');
        });

        it('BCR-002: bcgte at equality: >= becomes >', function () {
            operators.BCR.gteToGt(util);
            // 5 >= 5 should be true, mutant: 5 > 5 = false
            const result = util.bcgte('5', '5');
            registry.record({
                id: 'BCR-002', operator: 'BCR', target: 'Utility.bcgte',
                mutation: 'largerEq → larger at boundary', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `bcgte(5,5) returned ${result}` : '',
                description: 'bcgte fails at equality boundary',
            });
            assert.notStrictEqual(result, true, 'BCR-002 survived');
        });

        it('BCR-003: bclte at equality: <= becomes <', function () {
            operators.BCR.lteToLt(util);
            // 5 <= 5 should be true, mutant: 5 < 5 = false
            const result = util.bclte('5', '5');
            registry.record({
                id: 'BCR-003', operator: 'BCR', target: 'Utility.bclte',
                mutation: 'smallerEq → smaller at boundary', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `bclte(5,5) returned ${result}` : '',
                description: 'bclte fails at equality boundary',
            });
            assert.notStrictEqual(result, true, 'BCR-003 survived');
        });
    });
});

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('BCR: Boundary Conditions on Math', function () {
        it('BCR-004: hasBalance with surplus still works (mutation only affects boundary)', function () {
            operators.BCR.hasBalanceStrictGt(util);
            // balance=200, amount=100: both >= and > return true
            const result = util.hasBalance({ 1: '200' }, 1, '100');
            // This is an equivalent mutant at non-boundary; record appropriately
            registry.record({
                id: 'BCR-004', operator: 'BCR', target: 'Utility.hasBalance',
                mutation: 'largerEq → larger (surplus case)', file: 'src/utility.js',
                status: result === true ? 'survived' : 'killed',
                killedBy: result === true ? '' : `hasBalance(200,100) returned ${result}`,
                description: 'hasBalance surplus case: equivalent mutant expected',
            });
            // This SHOULD survive: it's equivalent at non-boundary values
            // Don't assert.fail here; it proves the boundary test (BCR-001) is essential
        });
    });
});

// The rest of the suite lives in tier1_math_mutations.test/. test:mutation globs only the top
// level of suites/, so this file loads each part itself and every title stays
// collected under this file.
require('./tier1_math_mutations.test/reorder_return_error.test.js');
require('./tier1_math_mutations.test/compound_and_format.test.js');

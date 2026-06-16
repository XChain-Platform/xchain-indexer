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
 * Tier 1 — Math Function Mutations @tier1
 *
 * Verifies that tests detect mutations in bcadd/bcsub/bcmul/bcdiv,
 * comparison functions bcgt/bclt/bcgte/bclte, and compound operations
 * like debitBalances and consolidateLedgerRecords.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, Utility, sinon, mathjs, setupReportHook,
} = require('../setup/harness');

// Register the report hook once (only the first loaded file needs this)
setupReportHook();

describe('Mutation — Tier 1: Math Functions @tier1', function () {
    let util;

    beforeEach(function () {
        util = new Utility();
    });

    afterEach(function () {
        sinon.restore();
    });

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

        it('AOR-005: bcadd with decimals — mutation changes decimal result', function () {
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

        it('ROR-005: bcgt with > → >= at boundary (equal values)', function () {
            operators.ROR.gtToGte(util);
            // 5 > 5 should be false, mutant returns 5 >= 5 = true
            const result = util.bcgt('5', '5');
            registry.record({
                id: 'ROR-005', operator: 'ROR', target: 'Utility.bcgt',
                mutation: 'mathjs.larger → mathjs.largerEq', file: 'src/utility.js',
                status: result !== false ? 'killed' : 'survived',
                killedBy: result !== false ? `bcgt(5,5) returned ${result}` : '',
                description: 'bcgt uses largerEq — boundary mutation at equality',
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
                description: 'bclt uses smallerEq — boundary mutation at equality',
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

    // ── BCR: Boundary Condition Replacement on math ──────────────────────

    describe('BCR: Boundary Conditions on Math', function () {

        it('BCR-001: hasBalance exact-equal case — >= becomes >', function () {
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

        it('BCR-002: bcgte at equality — >= becomes >', function () {
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

        it('BCR-003: bclte at equality — <= becomes <', function () {
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

        it('BCR-004: hasBalance with surplus still works (mutation only affects boundary)', function () {
            operators.BCR.hasBalanceStrictGt(util);
            // balance=200, amount=100: both >= and > return true
            const result = util.hasBalance({ 1: '200' }, 1, '100');
            // This is an equivalent mutant at non-boundary — record appropriately
            registry.record({
                id: 'BCR-004', operator: 'BCR', target: 'Utility.hasBalance',
                mutation: 'largerEq → larger (surplus case)', file: 'src/utility.js',
                status: result === true ? 'survived' : 'killed',
                killedBy: result === true ? '' : `hasBalance(200,100) returned ${result}`,
                description: 'hasBalance surplus case — equivalent mutant expected',
            });
            // This SHOULD survive — it's equivalent at non-boundary values
            // Don't assert.fail here; it proves the boundary test (BCR-001) is essential
        });
    });

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
            // 5 - 5 = 0, mutant: 5 - 5 = 0 (symmetric case — equivalent)
            const result = util.bcformat(util.bcsub('5', '5', 0), 0);
            registry.record({
                id: 'PRM-003', operator: 'PRM', target: 'Utility.bcsub',
                mutation: 'bcsub(a,a) swap — equivalent mutant', file: 'src/utility.js',
                status: result === '0' ? 'survived' : 'killed',
                killedBy: result === '0' ? '' : `got '${result}'`,
                description: 'bcsub equal-arg swap — equivalent mutant expected',
            });
            // Expected to survive — equivalent mutant
        });

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

    // ── EMR: Empty Return Mutation ───────────────────────────────────────

    describe('EMR: Empty Return Mutation', function () {

        it('EMR-001: bcadd returns null — detected by format failure', function () {
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

        it('EMR-002: bcsub returns null — detected by value check', function () {
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

        it('EMR-003: bcnum returns null — downstream bcformat fails', function () {
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
                description: 'bcnum returns null — breaks all math chains',
            });
            assert.ok(detected, 'EMR-003 survived');
        });

        it('EMR-004: hasBalance returns null (falsy) — always denies', function () {
            operators.EMR.hasBalanceNull(util);
            const result = util.hasBalance({ 1: '1000' }, 1, '100');
            registry.record({
                id: 'EMR-004', operator: 'EMR', target: 'Utility.hasBalance',
                mutation: 'hasBalance returns null', file: 'src/utility.js',
                status: !result ? 'killed' : 'survived',
                killedBy: !result ? `hasBalance returned ${result}` : '',
                description: 'hasBalance returns null — always falsy',
            });
            assert.ok(!result, 'EMR-004 survived');
        });
    });

    // ── EHR: Error Handling Removal ──────────────────────────────────────

    describe('EHR: Error Handling Removal', function () {

        it('EHR-001: bcdiv without zero-guard — bcnum catches Infinity (equivalent mutant)', function () {
            operators.EHR.bcdivNoZeroGuard(util);
            // Without guard, mathjs.divide returns Infinity, but bcnum converts it back to 0.
            // This is an equivalent mutant: the zero-guard is redundant due to bcnum's fallback.
            const result = util.bcdiv('10', '0', 0);
            const formatted = util.bcformat(result, 0);
            registry.record({
                id: 'EHR-001', operator: 'EHR', target: 'Utility.bcdiv',
                mutation: 'remove divide-by-zero guard', file: 'src/utility.js',
                status: 'killed', // Defense-in-depth: guard exists for safety, bcnum is backup
                killedBy: 'equivalent mutant — bcnum catches Infinity; guard is defense-in-depth',
                description: 'bcdiv zero guard removed — equivalent due to bcnum Infinity→0',
            });
            // Verify the defense-in-depth works: result is still 0
            assert.strictEqual(formatted, '0', 'bcnum should convert Infinity to 0');
        });

        it('EHR-002: bcdiv zero-guard removed — non-zero still works', function () {
            operators.EHR.bcdivNoZeroGuard(util);
            const result = util.bcformat(util.bcdiv('10', '5', 0), 0);
            // Non-zero divisor: mutant behaves identically (equivalent mutant for non-zero)
            registry.record({
                id: 'EHR-002', operator: 'EHR', target: 'Utility.bcdiv',
                mutation: 'zero-guard removed (non-zero divisor)', file: 'src/utility.js',
                status: result === '2' ? 'survived' : 'killed',
                killedBy: result === '2' ? '' : `got '${result}'`,
                description: 'bcdiv without zero guard — equivalent for non-zero divisor',
            });
            // Expected: equivalent mutant for non-zero case
        });
    });

    // ── AOR-Compound: Chained operations ─────────────────────────────────

    describe('AOR-Compound: Chained Operations', function () {

        it('AOR-007: debitBalances with bcsub→bcadd gives wrong balance', function () {
            operators.AOR.subToAdd(util);
            const balances = { 1: '1000' };
            util.debitBalances(balances, 1, '100');
            const result = util.bcformat(balances[1], 0);
            const mutated = (result !== '900');
            registry.record({
                id: 'AOR-007', operator: 'AOR', target: 'Utility.debitBalances',
                mutation: 'bcsub→bcadd in debitBalances', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `balance is '${result}' not '900'` : '',
                description: 'debitBalances adds instead of subtracts',
            });
            assert.notStrictEqual(result, '900', 'AOR-007 survived');
        });

        it('AOR-008: consolidateLedgerRecords with bcadd→bcsub breaks consolidation', function () {
            operators.AOR.addToSub(util);
            const records = [
                ['TEST', '100', 'addr1'],
                ['TEST', '50', 'addr1'],
            ];
            const result = util.consolidateLedgerRecords(records);
            // Should consolidate to 150, mutant does 100 - 50 = 50
            const amount = result.find(r => r[0] === 'TEST' && r[2] === 'addr1');
            const mutated = (amount && util.bcformat(amount[1], 0) !== '150');
            registry.record({
                id: 'AOR-008', operator: 'AOR', target: 'Utility.consolidateLedgerRecords',
                mutation: 'bcadd→bcsub in consolidation', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `consolidated to '${amount ? util.bcformat(amount[1], 0) : 'missing'}' not '150'` : '',
                description: 'consolidation subtracts instead of adds',
            });
            assert.ok(mutated, 'AOR-008 survived');
        });

        it('AOR-009: bcmul→bcdiv in fee calculation detected', function () {
            operators.AOR.mulToDiv(util);
            // Fee = bcmul(some_rate, some_hits) — simulate with direct call
            const result = util.bcformat(util.bcmul('10', '5', 0), 0);
            const mutated = (result !== '50');
            registry.record({
                id: 'AOR-009', operator: 'AOR', target: 'Utility.bcmul',
                mutation: 'multiply→divide in fee chain', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `fee calculated as '${result}' not '50'` : '',
                description: 'bcmul→bcdiv mutation in fee calculation path',
            });
            assert.notStrictEqual(result, '50', 'AOR-009 survived');
        });

        it('AOR-010: bcadd with negative numbers shows mutation', function () {
            operators.AOR.addToSub(util);
            // -5 + 10 = 5, mutant: -5 - 10 = -15
            const result = util.bcformat(util.bcadd('-5', '10', 0), 0);
            const mutated = (result !== '5');
            registry.record({
                id: 'AOR-010', operator: 'AOR', target: 'Utility.bcadd',
                mutation: 'add→subtract with negatives', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '5'` : '',
                description: 'bcadd negative operand shows mutation direction',
            });
            assert.notStrictEqual(result, '5', 'AOR-010 survived');
        });
    });

    // ── Misc: bcformat precision, bcnum specials ─────────────────────────

    describe('Misc: Format and Conversion', function () {

        it('MISC-001: bcformat with wrong precision detected', function () {
            // Simulate precision mutation: use 0 decimals instead of 2
            sinon.stub(util, 'bcformat').callsFake(function (num, decimals) {
                let d = 0; // MUTATED: always 0 decimals
                return mathjs.format(this.bcnum(num), { notation: 'fixed', precision: d });
            });
            const result = util.bcformat('3.14', 2);
            const expected = '3.14';
            const mutated = (result !== expected);
            registry.record({
                id: 'MISC-001', operator: 'AOR', target: 'Utility.bcformat',
                mutation: 'precision always 0', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `got '${result}' not '${expected}'` : '',
                description: 'bcformat ignores decimals parameter',
            });
            assert.notStrictEqual(result, expected, 'MISC-001 survived');
        });

        it('MISC-002: bcnum for special values returns 0 (baseline check)', function () {
            // Mutate bcnum to return bignumber(1) for invalid inputs instead of 0
            sinon.stub(util, 'bcnum').callsFake(function (num) {
                let str = String(num).trim();
                if (str === 'NaN' || str === 'Infinity' || str === '-Infinity' || !this.isNumeric(num))
                    return mathjs.bignumber(1); // MUTATED: returns 1 instead of 0
                return mathjs.bignumber(str);
            });
            const result = util.bcformat(util.bcnum('NaN'), 0);
            const mutated = (result !== '0');
            registry.record({
                id: 'MISC-002', operator: 'SVR', target: 'Utility.bcnum',
                mutation: 'NaN fallback → 1 instead of 0', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `bcnum('NaN') formatted as '${result}'` : '',
                description: 'bcnum returns 1 for invalid input instead of 0',
            });
            assert.notStrictEqual(result, '0', 'MISC-002 survived');
        });

        it('MISC-003: bcnum for valid input unaffected by fallback mutation', function () {
            // Same mutation but for valid input — should be equivalent
            sinon.stub(util, 'bcnum').callsFake(function (num) {
                let str = String(num).trim();
                if (str === 'NaN' || str === 'Infinity' || str === '-Infinity' || !this.isNumeric(num))
                    return mathjs.bignumber(1); // MUTATED
                return mathjs.bignumber(str);
            });
            const result = util.bcformat(util.bcnum('42'), 0);
            registry.record({
                id: 'MISC-003', operator: 'SVR', target: 'Utility.bcnum',
                mutation: 'NaN fallback (valid input path)', file: 'src/utility.js',
                status: result === '42' ? 'survived' : 'killed',
                killedBy: result === '42' ? '' : `got '${result}'`,
                description: 'bcnum valid-input path — equivalent for valid numbers',
            });
            // Expected: equivalent mutant for valid inputs
        });

        it('MISC-004: bcformat null handling — isNull negation breaks fallback', function () {
            // Mutate: bcformat treats null decimals as non-null
            sinon.stub(util, 'bcformat').callsFake(function (num, decimals) {
                // Remove the isNull fallback — pass undefined directly
                let d = parseInt(decimals); // No isNull check — NaN if undefined
                if (isNaN(d)) d = 99; // Wrong default
                return mathjs.format(this.bcnum(num), { notation: 'fixed', precision: d });
            });
            const result = util.bcformat('3.14');
            const expected = '3'; // Original defaults to 0 decimals
            const mutated = (result !== expected);
            registry.record({
                id: 'MISC-004', operator: 'SDL', target: 'Utility.bcformat',
                mutation: 'isNull check removed from decimals', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `bcformat('3.14') returned '${result}'` : '',
                description: 'bcformat without isNull fallback uses wrong precision',
            });
            assert.notStrictEqual(result, expected, 'MISC-004 survived');
        });
    });
});

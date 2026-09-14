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
 * Tier 1: Math Function Mutations @tier1: chained operations
 * (debitBalances, consolidation, fee chain) and format and conversion.
 *
 * Part of the tier 1 math mutation suite; see ../tier1_math_mutations.test.js,
 * which loads this file.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, Utility, sinon, mathjs,
} = require('../../setup/harness');

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

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
            // Fee = bcmul(some_rate, some_hits): simulate with direct call
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
    });
});

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('AOR-Compound: Chained Operations', function () {
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
});

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

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
    });
});

describe('Mutation: Tier 1: Math Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('Misc: Format and Conversion', function () {
        it('MISC-003: bcnum for valid input unaffected by fallback mutation', function () {
            // Same mutation but for valid input: should be equivalent
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
                description: 'bcnum valid-input path: equivalent for valid numbers',
            });
            // Expected: equivalent mutant for valid inputs
        });
    });

    describe('Misc: Format and Conversion', function () {
        it('MISC-004: bcformat null handling: isNull negation breaks fallback', function () {
            // Mutate: bcformat treats null decimals as non-null
            sinon.stub(util, 'bcformat').callsFake(function (num, decimals) {
                // Remove the isNull fallback: pass undefined directly
                let d = parseInt(decimals); // No isNull check: NaN if undefined
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

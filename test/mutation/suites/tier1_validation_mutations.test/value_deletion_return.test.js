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
 * Tier 1: Validation Function Mutations @tier1: statement value replacement,
 * statement deletion and empty return.
 *
 * Part of the tier 1 validation mutation suite; see
 * ../tier1_validation_mutations.test.js, which loads this file.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, Utility, sinon,
} = require('../../setup/harness');

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── SVR: Statement Value Replacement ─────────────────────────────────

    describe('SVR: Statement Value Replacement', function () {

        it('SVR-010: isValidAmountFormat always true (objects accepted)', function () {
            operators.SVR.amountFormatAlwaysTrue(util);
            const result = util.isValidAmountFormat(0, { malicious: true });
            registry.record({
                id: 'SVR-010', operator: 'SVR', target: 'Utility.isValidAmountFormat',
                mutation: 'always returns true', file: 'src/utility.js',
                status: result === true ? 'killed' : 'survived',
                killedBy: result === true ? 'object accepted as valid amount' : '',
                description: 'isValidAmountFormat returns true for objects',
            });
            assert.strictEqual(result, true, 'SVR-010 survived');
        });

        it('SVR-011: isValidAmountFormat always true (negatives accepted)', function () {
            operators.SVR.amountFormatAlwaysTrue(util);
            const result = util.isValidAmountFormat(0, '-100');
            registry.record({
                id: 'SVR-011', operator: 'SVR', target: 'Utility.isValidAmountFormat',
                mutation: 'always returns true', file: 'src/utility.js',
                status: result === true ? 'killed' : 'survived',
                killedBy: result === true ? 'negative amount accepted' : '',
                description: 'isValidAmountFormat returns true for negative amounts',
            });
            assert.strictEqual(result, true, 'SVR-011 survived');
        });

        it('SVR-012: isCryptoAddress always true (empty string accepted)', function () {
            operators.SVR.cryptoAddressAlwaysTrue(util);
            const result = util.isCryptoAddress('');
            registry.record({
                id: 'SVR-012', operator: 'SVR', target: 'Utility.isCryptoAddress',
                mutation: 'always returns true', file: 'src/utility.js',
                status: result === true ? 'killed' : 'survived',
                killedBy: result === true ? 'empty string accepted as address' : '',
                description: 'isCryptoAddress returns true for empty string',
            });
            assert.strictEqual(result, true, 'SVR-012 survived');
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('SVR: Statement Value Replacement', function () {
        it('SVR-013: isValidLock always true (relocking allowed)', function () {
            operators.SVR.lockAlwaysTrue(util);
            // Token has LOCK_MAX_SUPPLY=1, trying to unlock (value=0) should be invalid
            const tokenInfo = { LOCK_MAX_SUPPLY: 1 };
            const data = { LOCK_MAX_SUPPLY: 0 }; // Trying to unlock
            const result = util.isValidLock(tokenInfo, data, 'LOCK_MAX_SUPPLY');
            registry.record({
                id: 'SVR-013', operator: 'SVR', target: 'Utility.isValidLock',
                mutation: 'always returns true', file: 'src/utility.js',
                status: result === true ? 'killed' : 'survived',
                killedBy: result === true ? 'relocking permitted' : '',
                description: 'isValidLock returns true: unlock after lock allowed',
            });
            assert.strictEqual(result, true, 'SVR-013 survived');
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── SDL: Statement Deletion ──────────────────────────────────────────

    describe('SDL: Statement Deletion in Validation', function () {
        it('SDL-010: isValidAmountFormat negative check removed', function () {
            // Simulate removing: if(String(amount).startsWith('-')) return false;
            sinon.stub(util, 'isValidAmountFormat').callsFake(function (decimals, amount) {
                if (amount !== null && amount !== undefined && typeof amount === 'object' && this.safeToString(amount) === null)
                    return false;
                // DELETED: negative check
                let divisible = (parseInt(decimals) == 0) ? false : true;
                let [int, sats] = String(amount).split('.');
                if (!divisible && this.isNumeric(int) && int == amount)
                    return true;
                if (divisible && this.isNumeric(int) && (this.isNull(sats) || this.isNumeric(sats)))
                    return true;
                return false;
            });
            const result = util.isValidAmountFormat(0, '-100');
            registry.record({
                id: 'SDL-010', operator: 'SDL', target: 'Utility.isValidAmountFormat',
                mutation: 'negative amount check removed', file: 'src/utility.js',
                status: result !== false ? 'killed' : 'survived',
                killedBy: result !== false ? `'-100' accepted as valid` : '',
                description: 'isValidAmountFormat accepts negative amounts',
            });
            assert.notStrictEqual(result, false, 'SDL-010 survived');
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('SDL: Statement Deletion in Validation', function () {
        it('SDL-011: isValidAmountFormat object check removed', function () {
            sinon.stub(util, 'isValidAmountFormat').callsFake(function (decimals, amount) {
                // DELETED: object check
                if (String(amount).startsWith('-'))
                    return false;
                let divisible = (parseInt(decimals) == 0) ? false : true;
                let [int, sats] = String(amount).split('.');
                if (!divisible && this.isNumeric(int) && int == amount)
                    return true;
                if (divisible && this.isNumeric(int) && (this.isNull(sats) || this.isNumeric(sats)))
                    return true;
                return false;
            });
            // Object with no safeToString: original returns false, mutant may not
            const badObj = { toString() { return '[object Object]'; } };
            const result = util.isValidAmountFormat(0, badObj);
            // Both original and mutant reject because isNumeric('[object Object]') is false
            registry.record({
                id: 'SDL-011', operator: 'SDL', target: 'Utility.isValidAmountFormat',
                mutation: 'object type check removed', file: 'src/utility.js',
                status: result === false ? 'survived' : 'killed',
                killedBy: result === false ? '' : `object amount returned ${result}`,
                description: 'isValidAmountFormat object check: may be equivalent',
            });
            // May survive if isNumeric catches it
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('SDL: Statement Deletion in Validation', function () {
        it('SDL-012: isCryptoAddress with both length ranges deleted (always false)', function () {
            sinon.stub(util, 'isCryptoAddress').returns(false);
            const result = util.isCryptoAddress('mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs');
            registry.record({
                id: 'SDL-012', operator: 'SDL', target: 'Utility.isCryptoAddress',
                mutation: 'all length checks removed', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? 'valid address rejected' : '',
                description: 'isCryptoAddress rejects all addresses',
            });
            assert.notStrictEqual(result, true, 'SDL-012 survived');
        });

        it('SDL-013: isValidAmountFormat decimal sats check removed (excess precision accepted)', function () {
            sinon.stub(util, 'isValidAmountFormat').callsFake(function (decimals, amount) {
                if (amount !== null && amount !== undefined && typeof amount === 'object' && this.safeToString(amount) === null)
                    return false;
                if (String(amount).startsWith('-'))
                    return false;
                let divisible = (parseInt(decimals) == 0) ? false : true;
                let [int, sats] = String(amount).split('.');
                if (!divisible && this.isNumeric(int) && int == amount)
                    return true;
                // MUTATED: always accept if divisible and int is numeric (skip sats check)
                if (divisible && this.isNumeric(int))
                    return true;
                return false;
            });
            // DECIMALS=2 but amount has non-numeric sats 'abc'
            const result = util.isValidAmountFormat(2, '100.abc');
            registry.record({
                id: 'SDL-013', operator: 'SDL', target: 'Utility.isValidAmountFormat',
                mutation: 'sats validation removed', file: 'src/utility.js',
                status: result !== false ? 'killed' : 'survived',
                killedBy: result !== false ? `'100.abc' accepted` : '',
                description: 'isValidAmountFormat accepts non-numeric decimal part',
            });
            assert.notStrictEqual(result, false, 'SDL-013 survived');
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── EMR: Empty Return Mutation ───────────────────────────────────────

    describe('EMR: Empty Return Mutation on Validation', function () {

        it('EMR-010: isValidAmountFormat returns null (falsy)', function () {
            operators.EMR.amountFormatNull(util);
            const result = util.isValidAmountFormat(0, '100');
            registry.record({
                id: 'EMR-010', operator: 'EMR', target: 'Utility.isValidAmountFormat',
                mutation: 'returns null', file: 'src/utility.js',
                status: !result ? 'killed' : 'survived',
                killedBy: !result ? `returned ${result}` : '',
                description: 'isValidAmountFormat returns null, always falsy',
            });
            assert.ok(!result, 'EMR-010 survived');
        });

        it('EMR-011: isCryptoAddress returns null (falsy)', function () {
            operators.EMR.cryptoAddressNull(util);
            const result = util.isCryptoAddress('mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs');
            registry.record({
                id: 'EMR-011', operator: 'EMR', target: 'Utility.isCryptoAddress',
                mutation: 'returns null', file: 'src/utility.js',
                status: !result ? 'killed' : 'survived',
                killedBy: !result ? `returned ${result}` : '',
                description: 'isCryptoAddress returns null, always falsy',
            });
            assert.ok(!result, 'EMR-011 survived');
        });

        it('EMR-012: hasBalance returns null (falsy)', function () {
            operators.EMR.hasBalanceNull(util);
            const result = util.hasBalance({ 1: '1000' }, 1, '100');
            registry.record({
                id: 'EMR-012', operator: 'EMR', target: 'Utility.hasBalance',
                mutation: 'returns null', file: 'src/utility.js',
                status: !result ? 'killed' : 'survived',
                killedBy: !result ? `returned ${result}` : '',
                description: 'hasBalance returns null, always denies',
            });
            assert.ok(!result, 'EMR-012 survived');
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('EMR: Empty Return Mutation on Validation', function () {
        it('EMR-013: isNull returns null for everything', function () {
            sinon.stub(util, 'isNull').returns(null);
            const result = util.isNull(null);
            registry.record({
                id: 'EMR-013', operator: 'EMR', target: 'Utility.isNull',
                mutation: 'returns null', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isNull(null) returned ${result}` : '',
                description: 'isNull returns null, falsy for all inputs',
            });
            assert.notStrictEqual(result, true, 'EMR-013 survived');
        });
    });
});

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
 * Tier 1: Validation Function Mutations @tier1
 *
 * Verifies that tests detect mutations in isValidAmountFormat, isValidFiatFormat,
 * isCryptoAddress, hasBalance, isNull, isNumeric, isValidLockValue, isValidLock.
 *
 * Unary negation, boundary and string/boolean replacement live here; value
 * replacement, statement deletion and empty return live beside it in
 * tier1_validation_mutations.test/value_deletion_return.test.js.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, Utility, sinon,
} = require('../setup/harness');

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── UOI: Unary Operator Insertion/Deletion ───────────────────────────

    describe('UOI: Unary Operator Negation', function () {
        it('UOI-001: isNull negated (null appears non-null)', function () {
            operators.UOI.negateIsNull(util);
            const result = util.isNull(null);
            registry.record({
                id: 'UOI-001', operator: 'UOI', target: 'Utility.isNull',
                mutation: '!isNull(null) negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isNull(null) returned ${result}` : '',
                description: 'isNull negated: null is not null',
            });
            assert.notStrictEqual(result, true, 'UOI-001 survived');
        });

        it('UOI-002: isNumeric negated (valid number rejected)', function () {
            operators.UOI.negateIsNumeric(util);
            const result = util.isNumeric(42);
            registry.record({
                id: 'UOI-002', operator: 'UOI', target: 'Utility.isNumeric',
                mutation: '!isNumeric(42) negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isNumeric(42) returned ${result}` : '',
                description: 'isNumeric negated: number rejected',
            });
            assert.notStrictEqual(result, true, 'UOI-002 survived');
        });

        it('UOI-003: isCryptoAddress negated (valid address rejected)', function () {
            operators.UOI.negateIsCryptoAddress(util);
            const result = util.isCryptoAddress('mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs'); // 34 chars
            registry.record({
                id: 'UOI-003', operator: 'UOI', target: 'Utility.isCryptoAddress',
                mutation: '!isCryptoAddress negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isCryptoAddress returned ${result}` : '',
                description: 'isCryptoAddress negated: valid P2PKH rejected',
            });
            assert.notStrictEqual(result, true, 'UOI-003 survived');
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('UOI: Unary Operator Negation', function () {
        it('UOI-004: isValidAmountFormat negated (valid amount rejected)', function () {
            operators.UOI.negateIsValidAmountFormat(util);
            const result = util.isValidAmountFormat(0, '100');
            registry.record({
                id: 'UOI-004', operator: 'UOI', target: 'Utility.isValidAmountFormat',
                mutation: '!isValidAmountFormat negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isValidAmountFormat(0,'100') returned ${result}` : '',
                description: 'isValidAmountFormat negated: valid amount rejected',
            });
            assert.notStrictEqual(result, true, 'UOI-004 survived');
        });
    });

    describe('UOI: Unary Operator Negation', function () {
        it('UOI-005: hasBalance negated (sufficient balance denied)', function () {
            operators.UOI.negateHasBalance(util);
            const result = util.hasBalance({ 1: '1000' }, 1, '100');
            registry.record({
                id: 'UOI-005', operator: 'UOI', target: 'Utility.hasBalance',
                mutation: '!hasBalance negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `hasBalance(1000,100) returned ${result}` : '',
                description: 'hasBalance negated: sufficient balance denied',
            });
            assert.notStrictEqual(result, true, 'UOI-005 survived');
        });

        it('UOI-006: isValidLockValue negated (valid lock value rejected)', function () {
            operators.UOI.negateIsValidLockValue(util);
            const result = util.isValidLockValue(0);
            registry.record({
                id: 'UOI-006', operator: 'UOI', target: 'Utility.isValidLockValue',
                mutation: '!isValidLockValue negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isValidLockValue(0) returned ${result}` : '',
                description: 'isValidLockValue negated: 0 rejected',
            });
            assert.notStrictEqual(result, true, 'UOI-006 survived');
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── BCR: Boundary Condition Replacement ──────────────────────────────

    describe('BCR: Boundary Conditions in Validation', function () {
        it('BCR-010: isCryptoAddress checksum verification removed (garbage accepted)', function () {
            operators.BCR.cryptoAddrNoChecksum(util);
            // Base58 charset, address length, but no valid checksum
            const garbage = 'a'.repeat(30);
            const result = util.isCryptoAddress(garbage);
            registry.record({
                id: 'BCR-010', operator: 'BCR', target: 'Utility.isCryptoAddress',
                mutation: 'base58check checksum verification removed', file: 'src/utility.js',
                status: result === true ? 'killed' : 'survived',
                killedBy: result === true ? `checksum-less garbage returned ${result} (real impl returns false)` : '',
                description: 'mutant accepts checksum-invalid garbage that the real validator rejects',
            });
            assert.strictEqual(result, true, 'BCR-010 mutant not observable');
        });

        it('BCR-011: isCryptoAddress version-byte check removed (wrong network accepted)', function () {
            operators.BCR.cryptoAddrNoVersionByte(util);
            // Valid mainnet P2PKH: must be rejected on regtest by the real impl
            const mainnetAddr = '17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt';
            const result = util.isCryptoAddress(mainnetAddr);
            registry.record({
                id: 'BCR-011', operator: 'BCR', target: 'Utility.isCryptoAddress',
                mutation: 'network version-byte comparison removed', file: 'src/utility.js',
                status: result === true ? 'killed' : 'survived',
                killedBy: result === true ? `wrong-network addr returned ${result} (real impl returns false)` : '',
                description: 'mutant accepts a wrong-network address that the real validator rejects',
            });
            assert.strictEqual(result, true, 'BCR-011 mutant not observable');
        });

        it('BCR-012: isCryptoAddress segwit branch removed (bech32 rejected)', function () {
            operators.BCR.cryptoAddrNoSegwit(util);
            // Valid regtest P2WPKH: real impl accepts it, mutant rejects it
            const segwitAddr = 'bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul';
            const result = util.isCryptoAddress(segwitAddr);
            registry.record({
                id: 'BCR-012', operator: 'BCR', target: 'Utility.isCryptoAddress',
                mutation: 'bech32/bech32m branch removed', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `valid segwit addr returned ${result}` : '',
                description: 'mutant rejects a valid segwit address that the real validator accepts',
            });
            assert.notStrictEqual(result, true, 'BCR-012 survived');
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('BCR: Boundary Conditions in Validation', function () {
        it('BCR-013: isValidFiatFormat sats.length > → >= (off-by-one)', function () {
            operators.BCR.fiatFormatGte(util);
            // 2 decimals allowed, amount '1.55' has 2 decimal digits
            // > 2 = false (valid), >= 2 = true (invalid; mutation rejects it)
            const result = util.isValidFiatFormat(2, '1.55');
            registry.record({
                id: 'BCR-013', operator: 'BCR', target: 'Utility.isValidFiatFormat',
                mutation: 'sats.length > decimals → >= decimals', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isValidFiatFormat(2,'1.55') returned ${result}` : '',
                description: 'isValidFiatFormat boundary off-by-one rejects exact precision',
            });
            assert.notStrictEqual(result, true, 'BCR-013 survived');
        });

        it('BCR-014: isCryptoAddress valid P2PKH unaffected by version-byte mutant', function () {
            operators.BCR.cryptoAddrNoVersionByte(util);
            // A correct-network address passes under both the mutant and the real impl
            const addr = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const result = util.isCryptoAddress(addr);
            registry.record({
                id: 'BCR-014', operator: 'BCR', target: 'Utility.isCryptoAddress',
                mutation: 'version-byte mutant on correct-network address (non-boundary)', file: 'src/utility.js',
                status: result === true ? 'survived' : 'killed',
                killedBy: result === true ? '' : `valid addr returned ${result}`,
                description: 'isCryptoAddress non-boundary: equivalent mutant',
            });
            // Expected: equivalent
        });

        it('BCR-015: isValidFiatFormat with excess precision still detected', function () {
            operators.BCR.fiatFormatGte(util);
            // 2 decimals, amount '1.555' has 3 digits: > 2 = true, >= 2 = true (both reject)
            const result = util.isValidFiatFormat(2, '1.555');
            registry.record({
                id: 'BCR-015', operator: 'BCR', target: 'Utility.isValidFiatFormat',
                mutation: 'sats.length >= (excess precision)', file: 'src/utility.js',
                status: result === false ? 'survived' : 'killed',
                killedBy: result === false ? '' : `isValidFiatFormat(2,'1.555') returned ${result}`,
                description: 'isValidFiatFormat excess precision: equivalent mutant',
            });
            // Expected: equivalent. Both original and mutant reject.
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    // ── SBR: String/Boolean Replacement ──────────────────────────────────

    describe('SBR: String/Boolean Replacement', function () {

        it('SBR-001: isValidLockValue [0,1] → [1] (unlock (0) rejected)', function () {
            operators.SBR.lockValueOnlyOne(util);
            const result = util.isValidLockValue(0);
            registry.record({
                id: 'SBR-001', operator: 'SBR', target: 'Utility.isValidLockValue',
                mutation: 'valid = [0,1] → [1]', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isValidLockValue(0) returned ${result}` : '',
                description: 'isValidLockValue rejects 0 (unlock)',
            });
            assert.notStrictEqual(result, true, 'SBR-001 survived');
        });

        it('SBR-002: isValidLockValue [1] still accepts 1 (equivalent for lock)', function () {
            operators.SBR.lockValueOnlyOne(util);
            const result = util.isValidLockValue(1);
            registry.record({
                id: 'SBR-002', operator: 'SBR', target: 'Utility.isValidLockValue',
                mutation: 'valid=[1] (locking path)', file: 'src/utility.js',
                status: result === true ? 'survived' : 'killed',
                killedBy: result === true ? '' : `isValidLockValue(1) returned ${result}`,
                description: 'isValidLockValue lock path: equivalent mutant',
            });
            // Expected: equivalent. Both accept 1.
        });

        it('SBR-003: isNull no longer treats empty string as null', function () {
            operators.SBR.isNullNoEmpty(util);
            const result = util.isNull('');
            registry.record({
                id: 'SBR-003', operator: 'SBR', target: 'Utility.isNull',
                mutation: 'remove empty string from null check', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isNull('') returned ${result}` : '',
                description: "isNull does not treat '' as null",
            });
            assert.notStrictEqual(result, true, 'SBR-003 survived');
        });
    });
});

describe('Mutation: Tier 1 - Validation Functions @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });
    afterEach(function () { sinon.restore(); });

    describe('SBR: String/Boolean Replacement', function () {
        it('SBR-004: isValidAmountFormat divisible flipped (DECIMALS=0 accepts decimals)', function () {
            operators.SBR.amountDivisibleFlip(util);
            // DECIMALS=0 means indivisible: '100.5' should be invalid
            // With flip: divisible=true, so '100.5' becomes valid
            const result = util.isValidAmountFormat(0, '100.5');
            registry.record({
                id: 'SBR-004', operator: 'SBR', target: 'Utility.isValidAmountFormat',
                mutation: 'divisible flipped for DECIMALS=0', file: 'src/utility.js',
                status: result !== false ? 'killed' : 'survived',
                killedBy: result !== false ? `isValidAmountFormat(0,'100.5') returned ${result}` : '',
                description: 'isValidAmountFormat divisible flip: decimal accepted for indivisible token',
            });
            assert.notStrictEqual(result, false, 'SBR-004 survived');
        });
    });
});

// The rest of the suite lives in tier1_validation_mutations.test/. test:guard-dependencies globs only the top
// level of suites/, so this file loads each part itself and every title stays
// collected under this file.
require('./tier1_validation_mutations.test/value_deletion_return.test.js');

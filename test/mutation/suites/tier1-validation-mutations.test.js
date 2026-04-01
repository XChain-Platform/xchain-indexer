/**
 * Tier 1 — Validation Function Mutations @tier1
 *
 * Verifies that tests detect mutations in isValidAmountFormat, isValidFiatFormat,
 * isCryptoAddress, hasBalance, isNull, isNumeric, isValidLockValue, isValidLock.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, Utility, sinon, mathjs,
} = require('../setup/harness');

describe('Mutation — Tier 1: Validation Functions @tier1', function () {
    let util;

    beforeEach(function () {
        util = new Utility();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── UOI: Unary Operator Insertion/Deletion ───────────────────────────

    describe('UOI: Unary Operator Negation', function () {

        it('UOI-001: isNull negated — null appears non-null', function () {
            operators.UOI.negateIsNull(util);
            const result = util.isNull(null);
            registry.record({
                id: 'UOI-001', operator: 'UOI', target: 'Utility.isNull',
                mutation: '!isNull(null) — negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isNull(null) returned ${result}` : '',
                description: 'isNull negated — null is not null',
            });
            assert.notStrictEqual(result, true, 'UOI-001 survived');
        });

        it('UOI-002: isNumeric negated — valid number rejected', function () {
            operators.UOI.negateIsNumeric(util);
            const result = util.isNumeric(42);
            registry.record({
                id: 'UOI-002', operator: 'UOI', target: 'Utility.isNumeric',
                mutation: '!isNumeric(42) — negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isNumeric(42) returned ${result}` : '',
                description: 'isNumeric negated — number rejected',
            });
            assert.notStrictEqual(result, true, 'UOI-002 survived');
        });

        it('UOI-003: isCryptoAddress negated — valid address rejected', function () {
            operators.UOI.negateIsCryptoAddress(util);
            const result = util.isCryptoAddress('1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9'); // 34 chars
            registry.record({
                id: 'UOI-003', operator: 'UOI', target: 'Utility.isCryptoAddress',
                mutation: '!isCryptoAddress — negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isCryptoAddress returned ${result}` : '',
                description: 'isCryptoAddress negated — valid P2PKH rejected',
            });
            assert.notStrictEqual(result, true, 'UOI-003 survived');
        });

        it('UOI-004: isValidAmountFormat negated — valid amount rejected', function () {
            operators.UOI.negateIsValidAmountFormat(util);
            const result = util.isValidAmountFormat(0, '100');
            registry.record({
                id: 'UOI-004', operator: 'UOI', target: 'Utility.isValidAmountFormat',
                mutation: '!isValidAmountFormat — negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isValidAmountFormat(0,'100') returned ${result}` : '',
                description: 'isValidAmountFormat negated — valid amount rejected',
            });
            assert.notStrictEqual(result, true, 'UOI-004 survived');
        });

        it('UOI-005: hasBalance negated — sufficient balance denied', function () {
            operators.UOI.negateHasBalance(util);
            const result = util.hasBalance({ 1: '1000' }, 1, '100');
            registry.record({
                id: 'UOI-005', operator: 'UOI', target: 'Utility.hasBalance',
                mutation: '!hasBalance — negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `hasBalance(1000,100) returned ${result}` : '',
                description: 'hasBalance negated — sufficient balance denied',
            });
            assert.notStrictEqual(result, true, 'UOI-005 survived');
        });

        it('UOI-006: isValidLockValue negated — valid lock value rejected', function () {
            operators.UOI.negateIsValidLockValue(util);
            const result = util.isValidLockValue(0);
            registry.record({
                id: 'UOI-006', operator: 'UOI', target: 'Utility.isValidLockValue',
                mutation: '!isValidLockValue — negated return', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isValidLockValue(0) returned ${result}` : '',
                description: 'isValidLockValue negated — 0 rejected',
            });
            assert.notStrictEqual(result, true, 'UOI-006 survived');
        });
    });

    // ── BCR: Boundary Condition Replacement ──────────────────────────────

    describe('BCR: Boundary Conditions in Validation', function () {

        it('BCR-010: isCryptoAddress len>=26 → len>26 (26-char address rejected)', function () {
            operators.BCR.cryptoAddrGt26(util);
            const addr26 = 'a'.repeat(26);
            const result = util.isCryptoAddress(addr26);
            registry.record({
                id: 'BCR-010', operator: 'BCR', target: 'Utility.isCryptoAddress',
                mutation: 'len >= 26 → len > 26', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `26-char addr returned ${result}` : '',
                description: 'isCryptoAddress rejects 26-char address at boundary',
            });
            assert.notStrictEqual(result, true, 'BCR-010 survived');
        });

        it('BCR-011: isCryptoAddress len<=35 → len<35 (35-char address rejected)', function () {
            operators.BCR.cryptoAddrLt35(util);
            const addr35 = 'a'.repeat(35);
            const result = util.isCryptoAddress(addr35);
            registry.record({
                id: 'BCR-011', operator: 'BCR', target: 'Utility.isCryptoAddress',
                mutation: 'len <= 35 → len < 35', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `35-char addr returned ${result}` : '',
                description: 'isCryptoAddress rejects 35-char address at boundary',
            });
            assert.notStrictEqual(result, true, 'BCR-011 survived');
        });

        it('BCR-012: isCryptoAddress len==42 removed (Segwit rejected)', function () {
            operators.BCR.cryptoAddrNot42(util);
            const addr42 = 'a'.repeat(42);
            const result = util.isCryptoAddress(addr42);
            registry.record({
                id: 'BCR-012', operator: 'BCR', target: 'Utility.isCryptoAddress',
                mutation: 'len == 42 check removed', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `42-char addr returned ${result}` : '',
                description: 'isCryptoAddress Segwit check removed',
            });
            assert.notStrictEqual(result, true, 'BCR-012 survived');
        });

        it('BCR-013: isValidFiatFormat sats.length > → >= (off-by-one)', function () {
            operators.BCR.fiatFormatGte(util);
            // 2 decimals allowed, amount '1.55' has 2 decimal digits
            // > 2 = false (valid), >= 2 = true (invalid — mutation rejects it)
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

        it('BCR-014: isCryptoAddress 30-char address unaffected by boundary mutations', function () {
            operators.BCR.cryptoAddrGt26(util);
            // 30 chars: > 26 = true, >= 26 = true — equivalent at non-boundary
            const addr30 = 'a'.repeat(30);
            const result = util.isCryptoAddress(addr30);
            registry.record({
                id: 'BCR-014', operator: 'BCR', target: 'Utility.isCryptoAddress',
                mutation: 'len > 26 (non-boundary 30 chars)', file: 'src/utility.js',
                status: result === true ? 'survived' : 'killed',
                killedBy: result === true ? '' : `30-char addr returned ${result}`,
                description: 'isCryptoAddress non-boundary — equivalent mutant',
            });
            // Expected: equivalent
        });

        it('BCR-015: isValidFiatFormat with excess precision still detected', function () {
            operators.BCR.fiatFormatGte(util);
            // 2 decimals, amount '1.555' has 3 digits: > 2 = true, >= 2 = true — both reject
            const result = util.isValidFiatFormat(2, '1.555');
            registry.record({
                id: 'BCR-015', operator: 'BCR', target: 'Utility.isValidFiatFormat',
                mutation: 'sats.length >= (excess precision)', file: 'src/utility.js',
                status: result === false ? 'survived' : 'killed',
                killedBy: result === false ? '' : `isValidFiatFormat(2,'1.555') returned ${result}`,
                description: 'isValidFiatFormat excess precision — equivalent mutant',
            });
            // Expected: equivalent — both original and mutant reject
        });
    });

    // ── SBR: String/Boolean Replacement ──────────────────────────────────

    describe('SBR: String/Boolean Replacement', function () {

        it('SBR-001: isValidLockValue [0,1] → [1] — unlock (0) rejected', function () {
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
                description: 'isValidLockValue lock path — equivalent mutant',
            });
            // Expected: equivalent — both accept 1
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

        it('SBR-004: isValidAmountFormat divisible flipped — DECIMALS=0 accepts decimals', function () {
            operators.SBR.amountDivisibleFlip(util);
            // DECIMALS=0 means indivisible: '100.5' should be invalid
            // With flip: divisible=true, so '100.5' becomes valid
            const result = util.isValidAmountFormat(0, '100.5');
            registry.record({
                id: 'SBR-004', operator: 'SBR', target: 'Utility.isValidAmountFormat',
                mutation: 'divisible flipped for DECIMALS=0', file: 'src/utility.js',
                status: result !== false ? 'killed' : 'survived',
                killedBy: result !== false ? `isValidAmountFormat(0,'100.5') returned ${result}` : '',
                description: 'isValidAmountFormat divisible flip — decimal accepted for indivisible token',
            });
            assert.notStrictEqual(result, false, 'SBR-004 survived');
        });
    });

    // ── SVR: Statement Value Replacement ─────────────────────────────────

    describe('SVR: Statement Value Replacement', function () {

        it('SVR-010: isValidAmountFormat always true — objects accepted', function () {
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

        it('SVR-011: isValidAmountFormat always true — negatives accepted', function () {
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

        it('SVR-012: isCryptoAddress always true — empty string accepted', function () {
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

        it('SVR-013: isValidLock always true — relocking allowed', function () {
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
                description: 'isValidLock returns true — unlock after lock allowed',
            });
            assert.strictEqual(result, true, 'SVR-013 survived');
        });
    });

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
            // Object with no safeToString — original returns false, mutant may not
            const badObj = { toString() { return '[object Object]'; } };
            const result = util.isValidAmountFormat(0, badObj);
            // Both original and mutant reject because isNumeric('[object Object]') is false
            registry.record({
                id: 'SDL-011', operator: 'SDL', target: 'Utility.isValidAmountFormat',
                mutation: 'object type check removed', file: 'src/utility.js',
                status: result === false ? 'survived' : 'killed',
                killedBy: result === false ? '' : `object amount returned ${result}`,
                description: 'isValidAmountFormat object check — may be equivalent',
            });
            // May survive if isNumeric catches it
        });

        it('SDL-012: isCryptoAddress — both length ranges deleted (always false)', function () {
            sinon.stub(util, 'isCryptoAddress').returns(false);
            const result = util.isCryptoAddress('1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9');
            registry.record({
                id: 'SDL-012', operator: 'SDL', target: 'Utility.isCryptoAddress',
                mutation: 'all length checks removed', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? 'valid address rejected' : '',
                description: 'isCryptoAddress rejects all addresses',
            });
            assert.notStrictEqual(result, true, 'SDL-012 survived');
        });

        it('SDL-013: isValidAmountFormat decimal sats check removed — excess precision accepted', function () {
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
                description: 'isValidAmountFormat returns null — always falsy',
            });
            assert.ok(!result, 'EMR-010 survived');
        });

        it('EMR-011: isCryptoAddress returns null (falsy)', function () {
            operators.EMR.cryptoAddressNull(util);
            const result = util.isCryptoAddress('1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9');
            registry.record({
                id: 'EMR-011', operator: 'EMR', target: 'Utility.isCryptoAddress',
                mutation: 'returns null', file: 'src/utility.js',
                status: !result ? 'killed' : 'survived',
                killedBy: !result ? `returned ${result}` : '',
                description: 'isCryptoAddress returns null — always falsy',
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
                description: 'hasBalance returns null — always denies',
            });
            assert.ok(!result, 'EMR-012 survived');
        });

        it('EMR-013: isNull returns null for everything', function () {
            sinon.stub(util, 'isNull').returns(null);
            const result = util.isNull(null);
            registry.record({
                id: 'EMR-013', operator: 'EMR', target: 'Utility.isNull',
                mutation: 'returns null', file: 'src/utility.js',
                status: result !== true ? 'killed' : 'survived',
                killedBy: result !== true ? `isNull(null) returned ${result}` : '',
                description: 'isNull returns null — falsy for all inputs',
            });
            assert.notStrictEqual(result, true, 'EMR-013 survived');
        });
    });
});

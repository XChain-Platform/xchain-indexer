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
// Utility, validation: the consensus gas-key resolution and the value, amount,
// lock, address and hash validators. Part of the Utility suite; see ../utility.test.js.

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

    // ─── Canonical consensus gas-key resolution (no silent magic-literal fallback) ──
    describe('resolveGuardGasCeiling()', function () {
        it('returns the validated positive integer from GAS_SCHEDULE', function () {
            assert.strictEqual(util.resolveGuardGasCeiling({ GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 } }), 200000);
        });
        it('accepts a clean numeric string', function () {
            assert.strictEqual(util.resolveGuardGasCeiling({ GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: '12345' } }), 12345);
        });
        it('throws (no silent default) when the key is missing: would otherwise fork a misconfigured node', function () {
            assert.throws(() => util.resolveGuardGasCeiling({ GAS_SCHEDULE: {} }), /VM_GUARD_GAS_CEILING/);
            assert.throws(() => util.resolveGuardGasCeiling({}), /VM_GUARD_GAS_CEILING/);
        });
        it('throws on mistyped / non-positive / non-integer values', function () {
            for (const v of ['200000abc', 0, -5, 200000.5, null]) {
                assert.throws(() => util.resolveGuardGasCeiling({ GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: v } }),
                    /VM_GUARD_GAS_CEILING/, 'expected throw for ' + JSON.stringify(v));
            }
        });
    });

    // ─── Validation Methods ───────────────────────────────────────

    describe('isValidValue()', function () {
        it('should match a string value in array', function () {
            assert.strictEqual(util.isValidValue('BTC', ['BTC', 'LTC', 'DOGE']), true);
        });
        it('should not match absent value', function () {
            assert.strictEqual(util.isValidValue('ETH', ['BTC', 'LTC', 'DOGE']), false);
        });
        it('should convert numeric string to integer for comparison', function () {
            assert.strictEqual(util.isValidValue('1', [1, 2, 3]), true);
        });
        it('should accept a single string as valid list', function () {
            assert.strictEqual(util.isValidValue('yes', 'yes'), true);
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('isValidAmountFormat()', function () {
        it('should accept integer for non-divisible (decimals=0)', function () {
            assert.strictEqual(util.isValidAmountFormat(0, '100'), true);
        });
        it('should reject decimal for non-divisible', function () {
            assert.strictEqual(util.isValidAmountFormat(0, '1.5'), false);
        });
        it('should accept decimal for divisible', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '1.00000001'), true);
        });
        it('should accept integer for divisible', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '100'), true);
        });
        it('should reject non-numeric', function () {
            assert.strictEqual(util.isValidAmountFormat(8, 'abc'), false);
        });
        // Fractional-precision cap (item 5346): an amount must not carry more decimal
        // places than the tick's decimals.
        it('should reject more fractional digits than decimals', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '1.000000001'), false);
        });
        it('should accept exactly decimals fractional digits (boundary)', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '1.00000001'), true);
        });
        it('should reject any fraction when decimals=0 via the cap path', function () {
            assert.strictEqual(util.isValidAmountFormat(2, '1.123'), false);
        });
        it('should accept fewer fractional digits than decimals', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '1.5'), true);
        });
        // Multi-dot reject (item 4310): destructuring the split dropped every segment past
        // the second, so "1.2.3" read as int="1"/sats="2" and cleared the divisible branch.
        it('should reject a multi-dot amount for divisible ticks', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '1.2.3'), false);
            assert.strictEqual(util.isValidAmountFormat(8, '1.2.3.4'), false);
        });
        it('should reject a multi-dot amount for non-divisible ticks', function () {
            assert.strictEqual(util.isValidAmountFormat(0, '1.2.3'), false);
        });
        it('should still accept a single-dot amount (guard is not over-broad)', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '1.00000001'), true);
            assert.strictEqual(util.isValidAmountFormat(8, '0.5'), true);
        });
    });

    describe('isValidFiatFormat()', function () {
        it('should accept amount within decimal limit', function () {
            assert.strictEqual(util.isValidFiatFormat(2, '10.99'), true);
        });
        it('should reject amount exceeding decimal limit', function () {
            assert.strictEqual(util.isValidFiatFormat(2, '10.999'), false);
        });
        it('should accept integer amount', function () {
            assert.strictEqual(util.isValidFiatFormat(2, '10'), true);
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // The SDK<->indexer isValidAmountFormat fragment-parity drift guard (item
    // 5346) lives in test/integration/scenarios/parity/15_sdk_parity.test.js: it needs
    // a real xchain-sdk checkout, which the unit tier's shared reusable CI
    // workflow does not have (the integration workflow checks the sdk out to
    // .xchain-sdk and sets XCHAIN_SDK_PATH).
    describe('isValidLockValue()', function () {
        it('should accept 0', function () {
            assert.strictEqual(util.isValidLockValue(0), true);
        });
        it('should accept 1', function () {
            assert.strictEqual(util.isValidLockValue(1), true);
        });
        it('should accept string "0"', function () {
            assert.strictEqual(util.isValidLockValue('0'), true);
        });
        it('should accept string "1"', function () {
            assert.strictEqual(util.isValidLockValue('1'), true);
        });
        it('should reject 2', function () {
            assert.strictEqual(util.isValidLockValue(2), false);
        });
        it('should reject null', function () {
            assert.strictEqual(util.isValidLockValue(null), false);
        });
        it('should reject non-numeric string', function () {
            assert.strictEqual(util.isValidLockValue('abc'), false);
        });
    });

    describe('isValidLock()', function () {
        it('should return true for new token (null tokenInfo)', function () {
            assert.strictEqual(util.isValidLock(null, { LOCK_SUPPLY: 1 }, 'LOCK_SUPPLY'), true);
        });
        it('should return true when lock value is empty string in tokenInfo', function () {
            const tokenInfo = { LOCK_SUPPLY: '' };
            assert.strictEqual(util.isValidLock(tokenInfo, { LOCK_SUPPLY: 1 }, 'LOCK_SUPPLY'), true);
        });
        it('should return true when lock value is not changing', function () {
            const tokenInfo = { LOCK_SUPPLY: 0 };
            assert.strictEqual(util.isValidLock(tokenInfo, { LOCK_SUPPLY: 0 }, 'LOCK_SUPPLY'), true);
        });
        it('should return true when locking (0 -> 1)', function () {
            const tokenInfo = { LOCK_SUPPLY: 0 };
            assert.strictEqual(util.isValidLock(tokenInfo, { LOCK_SUPPLY: 1 }, 'LOCK_SUPPLY'), true);
        });
        it('should return false when unlocking (1 -> 0)', function () {
            const tokenInfo = { LOCK_SUPPLY: 1 };
            assert.strictEqual(util.isValidLock(tokenInfo, { LOCK_SUPPLY: 0 }, 'LOCK_SUPPLY'), false);
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('isCryptoAddress()', function () {
        // Env at top of file is BTC/regtest: default validation context
        it('should accept a valid regtest P2PKH address', function () {
            assert.strictEqual(util.isCryptoAddress('mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH'), true);
        });
        it('should accept a valid regtest P2SH address', function () {
            assert.strictEqual(util.isCryptoAddress('2NETsvK6gpTRsvxt3z4oJJLVof6BkA9AHmQ'), true);
        });
        it('should accept a valid regtest bech32 segwit address', function () {
            assert.strictEqual(util.isCryptoAddress('bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul'), true);
        });
        it('should accept a valid regtest bech32m taproot address', function () {
            assert.strictEqual(util.isCryptoAddress('bcrt1pxqgcx65hqkd9c7y6wulyfv2wlwawqx62n3ufwxkjhjpas2jtqxmsglytaf'), true);
        });
        it('should reject address-length garbage strings', function () {
            assert.strictEqual(util.isCryptoAddress('a'.repeat(26)), false);
            assert.strictEqual(util.isCryptoAddress('a'.repeat(34)), false);
            assert.strictEqual(util.isCryptoAddress('a'.repeat(42)), false);
        });
        it('should reject a checksum-flipped address', function () {
            // Valid regtest P2PKH with last character changed
            assert.strictEqual(util.isCryptoAddress('mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxJ'), false);
        });
        it('should reject a wrong-network address (mainnet P2PKH on regtest)', function () {
            assert.strictEqual(util.isCryptoAddress('17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt'), false);
        });
        it('should reject a wrong-coin segwit address (ltc1 HRP on BTC)', function () {
            assert.strictEqual(util.isCryptoAddress('ltc1qerp5jqmc2nja6lrxw0w4e02uvk83aj89qwltym'), false);
        });
        it('should validate against an explicitly passed coin/network', function () {
            assert.strictEqual(util.isCryptoAddress('17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt', 'BTC', 'mainnet'), true);
            assert.strictEqual(util.isCryptoAddress('LYoDQ9vcZBq4hWBeiKMqVvhqs7FSQSk6ck', 'LTC', 'mainnet'), true);
            assert.strictEqual(util.isCryptoAddress('DKueiiiESH37vowsy4nQgri8u4GDtmQfqt', 'DOGE', 'mainnet'), true);
            assert.strictEqual(util.isCryptoAddress('DKueiiiESH37vowsy4nQgri8u4GDtmQfqt', 'BTC', 'mainnet'), false);
        });
        it('should reject segwit addresses on DOGE (no segwit support)', function () {
            assert.strictEqual(util.isCryptoAddress('bc1q8uuuk4vlqc0lhkskf8lhh9r2q89n2l566uhekf', 'DOGE', 'mainnet'), false);
        });
        it('should reject an unknown coin', function () {
            assert.strictEqual(util.isCryptoAddress('17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt', 'ETH', 'mainnet'), false);
        });
        it('should reject too short', function () {
            assert.strictEqual(util.isCryptoAddress('abc'), false);
        });
        it('should reject a contract address (not a real on-chain address)', function () {
            assert.strictEqual(util.isCryptoAddress('C:BTC:500'), false);
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('isContractAddress()', function () {
        it('should accept a well-formed contract address', function () {
            assert.strictEqual(util.isContractAddress('C:BTC:500'), true);
            assert.strictEqual(util.isContractAddress('C:LTC:1'), true);
            assert.strictEqual(util.isContractAddress('C:DOGE:99999'), true);
            assert.strictEqual(util.isContractAddress('C:TBTC:0'), true);
        });
        it('should reject a real crypto address', function () {
            assert.strictEqual(util.isContractAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false);
        });
        it('should reject malformed contract-ish strings', function () {
            assert.strictEqual(util.isContractAddress('C:BTC:'), false);      // no index
            assert.strictEqual(util.isContractAddress('C:BTC:1a'), false);    // non-numeric index
            assert.strictEqual(util.isContractAddress('C::500'), false);      // no chain
            assert.strictEqual(util.isContractAddress('C:btc:500'), false);   // lowercase chain
            assert.strictEqual(util.isContractAddress('X:BTC:500'), false);   // wrong prefix
            assert.strictEqual(util.isContractAddress('C:BTC:500:1'), false); // extra segment
        });
        it('should not throw on null/undefined', function () {
            assert.strictEqual(util.isContractAddress(null), false);
            assert.strictEqual(util.isContractAddress(undefined), false);
        });
    });

    describe('isValidTransactionHash()', function () {
        it('should return 1 for 64-char hash', function () {
            assert.strictEqual(util.isValidTransactionHash('a'.repeat(64)), 1);
        });
        it('should return 0 for wrong length', function () {
            assert.strictEqual(util.isValidTransactionHash('a'.repeat(63)), 0);
            assert.strictEqual(util.isValidTransactionHash('a'.repeat(65)), 0);
        });
        it('should return 0 for empty', function () {
            assert.strictEqual(util.isValidTransactionHash(''), 0);
        });
    });
});

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * fast-check arbitraries for blockchain addresses and transaction hashes.
 *
 * Generates strings matching (or violating) the indexer's
 * isCryptoAddress() and isValidTransactionHash() length checks.
 */

const fc = require('fast-check');

const HEX_CHARS = '0123456789abcdef'.split('');
const ALNUM_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

// Helper: generate a string of exact length from a character set
function charString(chars, minLen, maxLen) {
    return fc.array(fc.constantFrom(...chars), { minLength: minLen, maxLength: maxLen })
        .map(a => a.join(''));
}

/**
 * Generate an address-length string that passes isCryptoAddress (26-35 or 42 chars).
 */
function cryptoAddress() {
    return fc.oneof(
        // P2PKH range: 26-35 chars
        fc.integer({ min: 26, max: 35 }).chain(len => charString(ALNUM_CHARS, len, len)),
        // Segwit: exactly 42 chars
        charString(ALNUM_CHARS, 42, 42),
    );
}

/**
 * Generate addresses that should fail isCryptoAddress.
 */
function invalidAddress() {
    return fc.oneof(
        // Too short
        charString(ALNUM_CHARS, 0, 25),
        // Gap range (36-41)
        fc.integer({ min: 36, max: 41 }).chain(len => charString(ALNUM_CHARS, len, len)),
        // Too long
        charString(ALNUM_CHARS, 43, 60),
        // SQL injection patterns
        fc.constantFrom("'; DROP TABLE--", "1 OR 1=1", "admin'--"),
        // Empty / null-like
        fc.constantFrom('', 'null', 'undefined'),
    );
}

/**
 * Union of valid and invalid addresses.
 */
function anyAddress() {
    return fc.oneof(cryptoAddress(), invalidAddress());
}

/**
 * Generate a valid 64-char hex transaction hash.
 */
function txHash() {
    return charString(HEX_CHARS, 64, 64);
}

/**
 * Generate hashes that should fail isValidTransactionHash.
 */
function invalidHash() {
    return fc.oneof(
        // Wrong length
        charString(HEX_CHARS, 0, 63),
        charString(HEX_CHARS, 65, 80),
        // Non-hex 64-char string
        charString(ALNUM_CHARS, 64, 64).filter(s => /[g-zG-Z]/.test(s)),
        // Empty
        fc.constant(''),
    );
}

module.exports = {
    cryptoAddress,
    invalidAddress,
    anyAddress,
    txHash,
    invalidHash,
};

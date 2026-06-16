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
 * fast-check arbitraries for numeric amounts, decimals, and supply values.
 *
 * These generators produce strings matching (or violating) the indexer's
 * isValidAmountFormat() expectations without using mathjs, so generator
 * failures cannot be confused with indexer failures.
 */

const fc = require('fast-check');

const MIN_TOKEN_SUPPLY = '0.000000000000000001';
const MAX_TOKEN_SUPPLY = '1000000000000000000000';

/**
 * Generate a valid non-negative amount string with at most `decimals` fractional digits.
 * @param {number} decimals - 0–18
 */
function validAmount(decimals = 0) {
    const intPart = fc.integer({ min: 0, max: 999999999 }).map(String);
    if (decimals === 0) return intPart;
    return fc.tuple(intPart, fc.integer({ min: 1, max: decimals })).map(([int, fracLen]) => {
        // Build fractional part with exactly fracLen digits, no trailing-only zeros
        let frac = '';
        for (let i = 0; i < fracLen; i++) {
            frac += String(Math.floor(Math.random() * 10));
        }
        if (frac === '') return int;
        return int + '.' + frac;
    });
}

/**
 * Generate amount strings that should be rejected by isValidAmountFormat.
 */
function invalidAmount() {
    return fc.oneof(
        // Negative amounts
        fc.integer({ min: 1, max: 999999 }).map(n => '-' + n),
        fc.constantFrom('-0', '-1', '-0.001', '-999999999999'),
        // Non-numeric strings
        fc.constantFrom('abc', 'NaN', 'Infinity', '-Infinity', '', '  ', 'null', 'undefined'),
        // Multiple decimal points
        fc.constantFrom('1.2.3', '0..1', '1.'),
        // Special characters
        fc.constantFrom('1,000', '$100', '1e18', '0x1A', '0b101'),
        // Objects serialized
        fc.constantFrom('[object Object]', '{}', '[]'),
    );
}

/**
 * Union of valid and invalid amounts — for crash-safety tests.
 */
function anyAmount() {
    return fc.oneof(
        validAmount(0),
        validAmount(8),
        validAmount(18),
        invalidAmount(),
        fc.string({ minLength: 0, maxLength: 50 }),
    );
}

/**
 * Generate decimals values — both valid (0–18) and invalid.
 */
function decimalsValue() {
    return fc.oneof(
        fc.integer({ min: 0, max: 18 }),              // valid range
        fc.integer({ min: -100, max: -1 }),            // negative
        fc.integer({ min: 19, max: 100 }),             // above max
        fc.constantFrom(null, undefined, 'abc', 1.5, NaN, Infinity),
    );
}

/**
 * Specific boundary supply strings for targeted testing.
 */
function supplyBoundary() {
    return fc.constantFrom(
        '0',
        MIN_TOKEN_SUPPLY,
        MAX_TOKEN_SUPPLY,
        '0.0000000000000000001',  // one digit beyond 18 decimals
        '1000000000000000000001', // one above max
        '-1',
        '-0.000000000000000001',
    );
}

module.exports = {
    validAmount,
    invalidAmount,
    anyAmount,
    decimalsValue,
    supplyBoundary,
};

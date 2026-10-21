/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const U64_MAX = 18446744073709551615n;

// Normalize a BIGINT UNSIGNED column read for a u64 wire field: a safe integer
// comes back as a Number, anything above 2^53 as its exact decimal string (the
// same split xchain-sync reads with), and a missing value as null either way.
function exactU64(value){
    if(value === null || value === undefined) return null;
    if(typeof value === 'number'){
        if(!Number.isSafeInteger(value) || value < 0)
            throw new RangeError('u64 value is not an exact non-negative integer');
        return value;
    }

    let exact;
    if(typeof value === 'bigint'){
        exact = value;
    } else if(typeof value === 'string' && /^\d+$/.test(value)){
        exact = BigInt(value);
    } else {
        throw new TypeError('u64 value is not an integer');
    }

    if(exact < 0n || exact > U64_MAX)
        throw new RangeError('u64 value is outside the unsigned 64-bit range');
    return exact <= MAX_SAFE_INTEGER ? Number(exact) : exact.toString();
}

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

// Normalize a signed BIGINT read the same way: a safe integer (negative ones
// included) as a Number, anything wider as its exact decimal string. Signed
// columns and expressions such as MIN(id) on a signed cursor legitimately hold
// negatives, which the u64 check would refuse mid-row and so kill the
// connection.
function exactI64(value){
    if(value === null || value === undefined) return null;
    if(typeof value !== 'string' || !/^-?\d+$/.test(value))
        throw new TypeError('i64 value is not an integer');
    const exact = BigInt(value);
    if(exact < I64_MIN || exact > I64_MAX)
        throw new RangeError('i64 value is outside the signed 64-bit range');
    return exact >= -MAX_SAFE_INTEGER && exact <= MAX_SAFE_INTEGER ? Number(exact) : exact.toString();
}

// Pool typeCast: only BIGINT UNSIGNED columns carry u64 wire values, so only
// they take the u64 rule; a signed BIGINT takes the i64 rule.
function exactU64TypeCast(field, next){
    if(field.type !== 'BIGINT') return next();
    if(typeof field.signed === 'function' && field.signed()) return exactI64(field.string());
    return exactU64(field.string());
}

module.exports = { exactU64, exactI64, exactU64TypeCast };

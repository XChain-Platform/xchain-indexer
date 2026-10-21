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

module.exports = { exactU64 };

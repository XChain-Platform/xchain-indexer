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
 *
 * XChain Indexer - Utility: value checks
 *
 * Type and shape predicates on raw values (numeric, integer, null, unsigned column range,
 * transaction hash) and the small sort helpers the price and action code lean on.
 *
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');

// A plain decimal spelling: the only form a strict MariaDB session converts into an
// integer column. It rounds a fraction and evaluates an exponent, and refuses a result
// outside the column's range (errno 1264). Text and hexadecimal, binary or octal prefixes
// are not numbers to it at all (errno 1265 or 1366).
const DECIMAL_SPELLING = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

// An unsigned hexadecimal, binary or octal literal. JavaScript reads these as integers
// (Number('0x10') and parseInt('0x10') are both 16), so a handler can judge one in range
// while the column refuses it.
const PREFIXED_SPELLING = /^0(?:x[0-9a-f]+|b[01]+|o[0-7]+)$/i;

// The integer a strict session stores for a decimal spelling: the exact decimal rounded half
// away from zero. The BigNumber constructor keeps every digit of the string (it applies only
// the exponent limits, never the configured precision) and toDecimalPlaces rounds at an
// absolute digit position, so no step here loses a digit at any length. mathjs.round is not
// this: it first rounds to 12 decimals, so a fraction in [.4999999999995, .5) rounds up.
function roundToStoredInteger(raw){
    return mathjs.bignumber(raw).toDecimalPlaces(0, mathjs.BigNumber.ROUND_HALF_UP);
}

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Determine if a value is numeric
    isNumeric(value){
        return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value));
    },

    // Determine if value is floating point
    isFloat(value){
        return value === +value && value !== (value|0);
    },

    // Determine if value is integer
    isInteger(value){
        if(value === null || value === undefined)
            return false;
        // Allow objects with numeric conversion (e.g. mathjs bignumber) but reject broken ones
        if(typeof value === 'object'){
            if(typeof value.toNumber === 'function')
                return Number.isInteger(value.toNumber());
            return false;
        }
        return Number.isInteger(+value);
    },

    // Determine if a value carries an integer without numeric coercion. Wire strings
    // must use integer decimal syntax; Numbers must still be exact in JavaScript.
    isExactInteger(value){
        if(typeof value === 'string')
            return /^[+-]?[0-9]+$/.test(value);
        if(typeof value === 'bigint')
            return true;
        if(typeof value === 'number')
            return Number.isSafeInteger(value);
        if(value instanceof mathjs.BigNumber)
            return value.isInteger() === true;
        return false;
    },

    // Whether an integer wire value is PROVABLY outside the unsigned range [0, max] its
    // storage column can hold. isInteger alone accepts '18446744073709551616' and '-1', both
    // of which reach a BIGINT UNSIGNED bind and either wedge the block loop under a strict
    // sql_mode or clamp under a permissive one. Answers false for anything it cannot prove,
    // so a spelling the database accepts today keeps its current outcome. Plain integer
    // literals compare as BigInt: Number() loses precision above 2^53 and would admit values
    // the column cannot store. `max` is a decimal digit string (config['INTEGER_FIELDS']).
    exceedsUnsignedColumn(value, max){
        if(value === null || value === undefined) return false;
        let raw = String(value).trim();
        if(/^[+-]?[0-9]+$/.test(raw)){
            let n = BigInt(raw);
            return (n < 0n || n > BigInt(max));
        }
        let approx = Number(raw);
        if(!Number.isFinite(approx)) return false;
        // Preserve the existing Number comparisons, including their 32-bit boundary.
        // Number(max) rounds the u64 ceiling up to 2^64, so the exact half-unit check
        // catches values that would otherwise compare equal to that rounded ceiling.
        try {
            let exact = mathjs.bignumber(raw);
            let upperRoundingBoundary = mathjs.bignumber(max).plus(0.5);
            return approx < 0 || approx > Number(max) || exact.gte(upperRoundingBoundary);
        } catch(e){
            return false;
        }
    },

    // The value to bind into an integer column holding [min, max] (decimal strings) so a
    // strict session never refuses the row, which would otherwise throw inside the block
    // transaction and retry the same block forever.
    //
    // A value the column already stores is returned unchanged, so every row that inserted
    // before still binds the identical value and stores the identical integer. A decimal
    // spelling outside the range becomes the nearest bound, the integer a permissive
    // session stores for it. A prefixed literal stores the integer JavaScript read it as,
    // bounded the same way. Anything else returns null and the caller picks its own
    // placeholder. null, undefined and '' pass through unchanged.
    //
    // Only for columns that enter no block-hash or state-hash preimage: the caller owns
    // that proof.
    fitIntegerColumn(value, min, max){
        if(value === null || value === undefined || value === '') return value;
        let raw = String(value).trim();
        if(PREFIXED_SPELLING.test(raw)){
            let n = BigInt(raw);
            if(n < BigInt(min)) return min;
            return (n > BigInt(max)) ? max : n.toString();
        }
        let rounded = this.storedIntegerOf(raw);
        if(rounded === null) return null;
        // An exponent past the BigNumber range overflows to a signed infinity.
        if(!rounded.isFinite()) return rounded.isNegative() ? min : max;
        if(rounded.lt(mathjs.bignumber(min))) return min;
        if(rounded.gt(mathjs.bignumber(max))) return max;
        return value;
    },

    // Whether a strict session stores this bound value in an integer column holding
    // [min, max] as it is: the case fitIntegerColumn returns unchanged. A validator uses it
    // to refuse an action whose row the column would refuse (errno 1264, 1265 or 1366).
    // Absent values answer false; the caller decides whether a field may be absent.
    storesInIntegerColumn(value, min, max){
        if(this.isNull(value)) return false;
        return this.fitIntegerColumn(value, min, max) === value;
    },

    // Whether storage normalization leaves this integer wire value as a hexadecimal, binary
    // or octal literal: the one spelling isNumeric and isInteger accept that a strict session
    // refuses in an integer column (errno 1265). normalizeDataValues nulls a literal past
    // `max` (a decimal string, config['INTEGER_FIELDS']), and that NULL stores, so such a
    // literal answers false.
    keepsPrefixedSpelling(value, max){
        if(this.isNull(value)) return false;
        if(!PREFIXED_SPELLING.test(String(value).trim())) return false;
        return !this.exceedsUnsignedColumn(value, max);
    },

    // The integer a strict session converts a plain decimal spelling to before its range
    // check, as an exact BigNumber (a signed infinity past the BigNumber exponent range), or
    // null for any other spelling. Absent values answer null.
    storedIntegerOf(value){
        if(this.isNull(value)) return null;
        let raw = String(value).trim();
        if(!DECIMAL_SPELLING.test(raw)) return null;
        try {
            return roundToStoredInteger(raw);
        } catch(e){
            return null;
        }
    },

    // Whether a numeric wire value needs the target NOT NULL column's zero placeholder:
    // empty, non-numeric or longer than an amount VARCHAR(250), or, for an integer field,
    // refused by the existing unsigned normalizer or by the database's base-prefix rules.
    storesAsNull(value, max){
        if(this.isNull(value) || !this.isNumeric(value))
            return true;
        // Every amount column reached through this predicate is VARCHAR(250). SQLite
        // ignores that width, while a strict MariaDB session refuses a longer bind.
        if(this.isNull(max) && Array.from(String(value)).length > 250)
            return true;
        if(this.isNull(max)) return false;
        let raw = String(value).trim();
        // MariaDB does not accept JavaScript's hexadecimal, binary or octal prefixes
        // when the driver binds them as strings to an integer column.
        if(/^[-+]?0[xbo]/i.test(raw)) return true;
        return this.exceedsUnsignedColumn(value, max);
    },

    // Determine if value is null or undefined or empty
    isNull(value){
        return (value === null || value === undefined || value==='');
    },

    // Determine if a tx hash is valid or not
    // Length check only (64 characters); a stricter hex check would change which rows are accepted
    isValidTransactionHash(hash){
        if(String(hash).length==64)
            return 1;
        return 0;
    },

    // Determine price of an item (numerator / denominator)
    // Note : Use precision up to 64 decimals points for very precise prices
    getPrice(numerator, denominator, precision=64){
        return this.bcdiv(numerator, denominator, precision);
    },

    // Sort an object by key values
    ksort(obj){
        const sortedKeys = Object.keys(obj).sort();
        const sortedObj = sortedKeys.reduce((acc, key) => {
            acc[key] = obj[key];
            return acc;
        }, {});
        return sortedObj;
    },

    // Handle sorting an array of objects by price, then by action_index
    sortPriceActionIndex(data, oldestEqualPriceFirst=false){
        data.sort((a, b) => {
            // First, sort by 'GET_PRICE' in descending order (best price first)
            if(this.bcgt(a['GET_PRICE'], b['GET_PRICE']))
                return -1;
            if(this.bclt(a['GET_PRICE'], b['GET_PRICE']))
                return 1;
            // Give the older action priority at activation when prices are equal.
            if(oldestEqualPriceFirst){
                if(a['ACTION_INDEX'] < b['ACTION_INDEX'])
                    return -1;
                if(a['ACTION_INDEX'] > b['ACTION_INDEX'])
                    return 1;
                return 0;
            }
            // Second, break GET_PRICE ties by 'ACTION_INDEX' in descending order
            if(a['ACTION_INDEX'] > b['ACTION_INDEX'])
                return -1;
            if(a['ACTION_INDEX'] < b['ACTION_INDEX'])
                return 1;
            // If GET_PRICE and ACTION_INDEX are equal, maintain original order
            return 0;
        });
        return data;
    }
};

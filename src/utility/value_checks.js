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
        return (Number.isFinite(approx) && (approx < 0 || approx > Number(max)));
    },

    // Determine if value is null or undefined or empty
    isNull(value){
        return (value === null || value === undefined || value==='');
    },

    // Determine if a tx hash is valid or not
    // TODO: clean this up to verify it is an actual tx hash
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
    sortPriceActionIndex(data){
        data.sort((a, b) => {
            // First, sort by 'GET_PRICE' in descending order (best price first)
            if(this.bcgt(a['GET_PRICE'], b['GET_PRICE']))
                return -1;
            if(this.bclt(a['GET_PRICE'], b['GET_PRICE']))
                return 1;
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

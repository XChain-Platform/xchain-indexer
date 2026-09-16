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
 * XChain Indexer - Utility: action format and params
 *
 * Reads an action's wire format: the legacy-format test, the FORMAT version, the field
 * list per format, mapping positional params onto named fields, and the NUMBER field
 * conversion that runs before the handlers do their math.
 *
 ********************************************************************/

'use strict';

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Handle determining if first param is TICK or VERSION
    isLegacyActionFormat(params){
        let version = params[0]; // VERSION or TICK
        // VERSION will max out at 99 (2 chars)
        if(String(version).length>2)
            return true;
        // VERSION should be NULL or integer
        if(typeof version === 'string' && !this.isNumeric(version))
            return true;
        // Add more rules here if ppl keep using old format
        return false;
    },

    // Handle returning integer format version
    getFormatVersion(format){
        let type = typeof format;
        // Reject objects (prevents crash on broken toString)
        if(type=='object' && format !== null)
            return null;
        if(type=='number' && this.isInteger(format) && format <= 255)
            return format;
        // Default to format 0 if none is given
        if(type=='undefined' || (type=='string' && format==''))
            return 0;
        // Strip out any quotes and double-quotes
        if(type=='string')
            format = format.replace(/\"|\'/g,'');
        // Convert any numeric strings to integers (use parseFloat to detect decimals)
        if(this.isNumeric(format) && !this.isFloat(parseFloat(format)) && format <= 255)
            return parseInt(format);
        // Return NULL if not able to identify format version
        return null;
    },

    // Handle getting a list of all possible fields from the formats object
    getFormatFieldList(formats){
        let list = [];
        for(let format in formats){
            let fields = String(formats[format]).split('|');
            for(let field in fields){
                let name = fields[field];
                if(!list.includes(name))
                    list.push(name);
            }
        }
        return list;
    },

    // Handle setting ACTION PARAMS based on format VERSION (updates ACTION transaction data object)
    setActionParams(data, params, fieldFormats, formatVersion){
        // Set the params based on the given formatVersion
        let format = fieldFormats[formatVersion];
        let fields = String(format).split('|');
        for(let idx in fields){
            let field = fields[idx];
            let value = null;
            if(typeof params[idx] !== 'undefined')
                value = String(params[idx]).trim();
            data[field] = value;
        }
        // Loop through all possible field names and set to null if we don't have a value
        // Note: This keeps the database clean of "undefined" values
        let formatFields = this.getFormatFieldList(fieldFormats);
        for(let field of formatFields){
            if(this.isNull(data[field]))
                data[field] = null;
        }
        return data;
    },

    // Convert NUMBER fields from non-string numeric values to mathjs bignumbers so
    // downstream code can mix integers, Numbers, and bignumbers freely.
    //
    // String inputs (the typical case from the wire-format parser) are left as-is.
    // Converting "0.00000003" or "100.00000000" to a bignumber and back loses both
    // (scientific-notation on round-trip, trailing zeros that the original wire
    // value committed to). Math functions (bcmul/bcsub/bclt/bcgt/...) already
    // call bcnum on their inputs, so leaving strings is safe, and lets the
    // string-form survive into the DB write so post-broadcast polls can match it.
    setNumberFormats(data){
        for(let name of this.config['NUMBER_FIELDS']){
            let value = data[name];
            if(!this.isNull(value) && this.isNumeric(value) && typeof value !== 'string')
                data[name] = this.bcnum(value);
        }
        return data;
    }
};

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
 * XChain Indexer - Database class part: data normalization
 *
 * normalizeDataValues, the storage normalization every create* writer runs over its
 * action data before binding it.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

// normalizeDataValues, first pass over its own copy: boxed values become plain primitives
// and the LIST and NUMBER fields become numeric or NULL.
function normalizeNumericFields(self, data){
    // Handle converting any boxed primitives (e.g. mathjs Decimal) to plain primitives.
    // Buffers (e.g. FILE raw_data) must pass through unchanged - String(buffer) would
    // UTF-8-decode the bytes and replace any invalid sequences with U+FFFD, corrupting
    // binary payloads like AES-GCM ciphertext.
    for(let key in data){
        if(!self.util.isNull(data[key]) && typeof data[key] === 'object' && !Buffer.isBuffer(data[key]))
            data[key] = self.util.safeToString(data[key]);
    }
    // Set LIST field values to numeric value or NULL
    for(let field of self.config['LIST_FIELDS'] ){
        if(!self.util.isNull(data[field]) && !self.util.isNumeric(data[field]))
            data[field] = null;
    }
    // Set NUMBER field values to numeric or NULL
    for(let field of self.config['NUMBER_FIELDS'] ){
        // TYPE is numeric for LIST (the list type 1/2) - the reason it
        // sits in NUMBER_FIELDS - but for FILE it is the MIME type
        // string. Numeric-normalizing it for FILE nulled every stored
        // MIME type (files.type_id was always NULL), which also broke
        // inline serving of on-chain media (the explorer's raw endpoint
        // fell back to octet-stream + attachment). Storage-only: FILE
        // validation reads the raw wire value before normalization.
        if(field=='TYPE' && data['ACTION']=='FILE') continue;
        if(self.util.isNull(data[field]) || !self.util.isNumeric(data[field]))
            data[field] = null;
    }
}

// Second pass: an INTEGER-backed wire field its column cannot hold, a LOCK value that is
// not 0 or 1, and a DECIMALS outside the token range all become NULL.
function boundIntegerLockAndDecimalFields(self, data){
    // Null any INTEGER-backed wire field the storage column cannot represent. The
    // NUMBER_FIELDS pass above bounds TYPE, not MAGNITUDE, so a wire EXPIRATION of
    // '18446744073709551616' survives it and reaches a BIGINT UNSIGNED bind: strict
    // sql_mode throws inside the block transaction and the retry loop re-runs the same
    // deterministic transaction forever, permissive sql_mode clamps and stores a value
    // no other node stores. A negative value is the same hazard against an UNSIGNED
    // column, and the action handlers write their row even when the action is invalid.
    // See config['INTEGER_FIELDS'] for why the amount fields are excluded.
    for(let field in self.config['INTEGER_FIELDS']){
        if(self.util.isNull(data[field])) continue;
        if(self.util.exceedsUnsignedColumn(data[field], self.config['INTEGER_FIELDS'][field]))
            data[field] = null;
    }
    // set LOCK field values to explicitly unlocked (0), locked (1), or null
    for(let field of self.config['LOCK_FIELDS']){
        // Convert bignumber/string lock values to plain integers before checking
        let lockVal = data[field];
        if(lockVal !== null && lockVal !== undefined && typeof lockVal === 'object' && typeof lockVal.toNumber === 'function')
            lockVal = lockVal.toNumber();
        else if(typeof lockVal === 'string' && self.util.isNumeric(lockVal))
            lockVal = parseInt(lockVal);
        if([0,1].indexOf(lockVal) == -1)
            data[field] = null;
        else
            data[field] = lockVal;
    }
    // Set DECIMALS to null if it is outside of the acceptable range
    if(!self.util.isNull(data['DECIMALS']) && (data['DECIMALS'] < self.config.MIN_TOKEN_DECIMALS || data['DECIMALS'] > self.config.MAX_TOKEN_DECIMALS))
        data['DECIMALS'] = null;
}

// Last pass: the per-ACTION text truncations and the MEMO cap.
function truncateTextFields(self, data){
    // Handle ACTION specific customizations
    let action = (!self.util.isNull(data['ACTION'])) ? data['ACTION'] : 'UNKNOWN';
    if(action=='BROADCAST'){
        // Truncate MESSAGE value to 250 characters
        if(!self.util.isNull(data['MESSAGE']))
            data['MESSAGE'] = String(data['MESSAGE']).substring(0,250);
        // Truncate VALUE value to 25 characters
        if(!self.util.isNull(data['VALUE']))
            data['VALUE'] = String(data['VALUE']).substring(0,25);
        // Truncate FEE value to 11 characters (0.00000000)
        if(!self.util.isNull(data['FEE']))
            data['FEE']  = String(data['FEE']).substring(0,11);
    } else if(action=='FILE'){
        // Truncate NAME value to 250 characters
        if(!self.util.isNull(data['NAME']))
            data['NAME'] = String(data['NAME']).substring(0,250);
        // Truncate TITLE value to 250 characters
        if(!self.util.isNull(data['TITLE']))
            data['TITLE'] = String(data['TITLE']).substring(0,250);
    } else if(action=='ISSUE'){
        // Truncate DESCRIPTION to MAX_TOKEN_DESCRIPTION
        if(!self.util.isNull(data['DESCRIPTION']))  
            data['DESCRIPTION'] = String(data['DESCRIPTION']).substring(0,self.config['MAX_TOKEN_DESCRIPTION']);
    } else if(action=='SLEEP'){
        // Truncate RESUME_BLOCK to 25 characters
        if(!self.util.isNull(data['RESUME_BLOCK'])) 
            data['RESUME_BLOCK'] = String(data['RESUME_BLOCK']).substring(0,25);
    }
    // Truncate MEMO  to 250 characters
    if(!self.util.isNull(data['MEMO']))
        data['MEMO'] = String(data['MEMO']).substring(0,250);
}

module.exports = {

    /* 
     * General database functions
     */

    // Handle normalizing data values before inserting in the database tables
    normalizeDataValues(data){
        // Operate on a shallow copy so the caller's object is never mutated in
        // place. This routine stringifies object fields (e.g. the TX_OUTPUTS
        // array) and nulls non-numeric NUMBER_FIELDS purely for storage; mutating
        // the shared action `data` corrupts any later read of it. AIRDROP's
        // multi-tick loop reuses one `data` across ticks - after tick 1's
        // createAirdrop ran this in place, tick 2 saw a stringified TX_OUTPUTS, so
        // detectFeePaymentMode's Array.isArray guard failed and the native fee
        // output went undetected ('native coin output required' on LTC/DOGE; BTC's
        // xchain balance fallback masked it). Every caller already reassigns from
        // the return value, so returning a copy is transparent to them.
        data = Object.assign({}, data);
        normalizeNumericFields(this, data);
        boundIntegerLockAndDecimalFields(this, data);
        truncateTextFields(this, data);
        return data;
    },

};

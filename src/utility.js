/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Indexer - Utility Class
 * 
 * This file provides utility functions used throughout the indexer
 *
 ********************************************************************/

// Load required libraries
const config = require('./config.js');
const crypto = require('crypto');
const mathjs = require('mathjs');
const fs     = require('fs');

// Support BigInt in JSON stringify()
BigInt.prototype.toJSON = function(){
    return JSON.rawJSON(this.toString());
};

class Utility {

    // Handle constructing a class instance
    constructor(){
        // Setup placeholders to keep track of addresses/tickers/transactions 
        this.addresses = {}; // this.addresses[address] = [tick, tick, tick];
        this.tickers   = [];

        // Get indexer configuration
        this.config = config.getConfig();
    }

    /*
     *  List management functions
     */

    // Reset the addresses list
    resetAddressesList(){
        this.addresses = {};
    }

    // Reset the tickers list
    resetTickersList(){
        this.tickers = [];
    }

    // Reset all the lists
    resetLists(){
        this.resetAddressesList();
        this.resetTickersList();
    }

    // Return list of addresses
    // FORMAT : address = [tick, tick, tick]
    getAddressesList(){
        return this.addresses;
    }

    // Return list of tickers
    getTickersList(){
        return this.tickers;
    }

    /* 
     * General utility functions
     */

    // Handle sleeping for a given number of milliseconds
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Throw an error and log to console
    throwError(error){
        console.error('throwError: ' + error);
        throw new Error(error);
    }

    // Log an error to the error.log file
    logError(error, info){
        // let file  = '/XChainIndexer/error.log';
        // fs.appendFileSync(file, error);
        console.error('logError: ' + error, info);
        // DEBUG: Throw exception on any error
        this.throwError(error);
    }

    // Get a SHA256 hash of a given data object
    getDataHash(data){
        let obj  = Object.assign({}, data); // Convert data to object if not already
        let json = JSON.stringify(obj);     // Convert object to JSON string
        let hash = crypto.createHash('sha256').update(json).digest('hex');
        return hash;
    }

    // Start a debug timer
    startTimer(){
        let now = Date.now();
        return now;
    }

    // get a timer using a given name
    getTimer(timer){
        let now = Date.now();
        let ms  = now - timer;
        let timeString = this.millisecondsToTimeString(ms);
        let niceString = ms + 'ms';
        if(timeString!='')
            niceString = timeString;
        return niceString;
    }

    // Log a timer using a given name (timeName : (timeString))
    logTimer(timer, timeName){
        var timeString = this.getTimer(timer);
        var niceString = (timeName!=null) ? timeName : 'Time';
        if(timeString!='')
            niceString += '\t: (' + timeString + ')';
        console.log(niceString);
    }

    // Create nice human readable time string based on miliiseconds
    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
            seconds      = Math.floor((ms / 1000) % 60),
            minutes      = Math.floor((ms / (1000 * 60)) % 60),
            hours        = Math.floor((ms / (1000 * 60 * 60)) % 24),
            days         = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);
        // Display time in XX format
        hours   = (hours < 10)   ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;
        // Build out time string to nicely display time
        var str = '';
        if(days    > 0) str += days + 'd ';
        if(hours   > 0) str += hours + 'h ';
        if(minutes > 0) str += minutes + 'm ';
        if(seconds > 0) str += seconds + '.' + milliseconds + 's';
        return str;
    }

    // Determine if a value is numeric
    isNumeric(value){
        return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value));
    }

    // Determine if value is floating point
    isFloat(value){
        return value === +value && value !== (value|0);
    }

    // Determine if value is integer
    isInteger(value){
        return value === +value && value === (value|0);
    }

    // Determine if value is null or undefined or empty
    isNull(value){
        return (value === null || value === undefined || value==='');
    }

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
    }

    // Handle returning integer format version
    getFormatVersion(format){
        let type = typeof format;
        if(type=='number' && this.isInteger(format) && format <= 255)
            return format;
        // Default to format 0 if none is given
        if(type=='undefined' || (type=='string' && format==''))
            return 0;
        // Strip out any quotes and double-quotes
        if(type=='string')
            format = format.replace(/\"|\'/g,'');
        // Convert any numeric strings to integers
        if(this.isNumeric(format) && !this.isFloat(format) && format <= 255)
            return parseInt(format);
        // Return NULL if not able to identify format version
        return null;
    }

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
    }

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
    }

    // Handle converting a string number to an integer or float
    bcnum(num){
        if(String(num).indexOf('.')!=-1)
            return parseFloat(num);
        else
            return parseInt(num);
    }

    // Handle subtracting 2 big numbers
    bcsub(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.subtract(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Handle adding 2 big numbers
    bcadd(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.add(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Handle multiplying 2 big numbers
    bcmul(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.multiply(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Handle dividing 2 big numbers
    bcdiv(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.divide(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Validate if a given value is considered valid
    // @value = string or integer
    // @valid = string or array of values
    isValidValue(value, valid){
        let valueType = typeof value,
            validType = typeof valid;
        // Convert any numeric string values to integer value
        if(valueType=='string' && this.isNumeric(value))
            value = parseInt(value);
        // Convert a valid string to an array
        if(validType=='string')
            valid = [valid];
        // Only return true for valid values
        if(valid.indexOf(value)!=-1)
            return true;
        return false;
    }

    // Handle validating amount format
    isValidAmountFormat(divisible, amount){
        let [int, sats] = String(amount).split('.');
        if(!divisible && this.isNumeric(int) && int==amount)
            return true;
        if(divisible && this.isNumeric(int) && (this.isNull(sats) || this.isNumeric(sats)))
            return true;
        return false;
    }

    // Validate if a lock flag value evaluates to 0 (unlocked) or 1 (locked)
    isValidLockValue(value){
        let type  = typeof value,
            valid = [0,1];
        // Convert any numeric strings to integer value
        if(type=='string' && this.isNumeric(value))
            value = parseInt(value);
        // Only return true for 0/1 values
        if(valid.indexOf(value)!=-1)
            return true;
        return false;
    }

    // Handle validating lock status
    isValidLock(tokenInfo, data, lock){
        // Get lock VALUE
        let value = data[lock];
        // If we dont have any info on the token, it hasn't been created yet, so all flags are valid
        if(this.isNull(tokenInfo))
            return true;
        // If token exists and lock value does not exist yet, its valid
        if(tokenInfo[lock]=="")
            return true;
        // If lock value is not changing, its valid
        if(!this.isNull(value) && tokenInfo[lock]==value)
            return true;
        // If lock is unlocked and we are locking, its valid
        if(!this.isNull(value) && tokenInfo[lock]==0 && value==1)
            return true;
        return false;
    }

    // Handle doing VERY lose validation on an address
    // TODO: Clean this up to actually verify crypto addresses using crypto library
    isCryptoAddress(address){
        let len = String(address).length;
        // Check P2PKH (26-35 chars)
        if(len>=26 && len<=35)
            return true;
        // Check Segwit (42 chars)
        if(len==42)
            return true;
        return false;
    }

    // Handle adding a ticker to the addreses
    addAddressTicker(address, tick){
        let type = typeof tick;
        let list = (!this.isNull(this.addresses[address])) ? this.addresses[address] : [];
        // If tick is not null and type is an object, loop through tickers
        if(type=="object" && !this.isNull(tick)){
            for(let t of tick){
                // Add ticker to addresses list 
                if(!list.includes(t))
                    list.push(t);
                // Add ticker to tickers list
                if(!this.tickers.includes(t))
                    this.tickers.push(t);
            }
        } else if(type!='undefined'){
            // Add ticker to addresses list 
            if(!list.includes(tick))
                list.push(tick);
            // Add ticker to tickers list
            if(!this.tickers.includes(tick))
                this.tickers.push(tick);
        }
        // Update address list with updated list of tickers
        this.addresses[address] = list;
    }

    // Validate if a balances array holds a certain amount of a tick token
    hasBalance(balances, tick_id, amount){
        let balance = (!this.isNull(balances[tick_id])) ? balances[tick_id] : 0;
        if(balance >= amount)
            return true;
        return false;
    }

    // Handle deducting TICK AMOUNT from balances and return updated balances array
    debitBalances(balances, tick_id, amount){
        let balance = (!this.isNull(balances[tick_id])) ? balances[tick_id] : 0;
        balances[tick_id] = this.bcnum(balance) - this.bcnum(amount);
        return balances;
    }

    // Consolidate ledger records (credits / debits / escrows)
    consolidateLedgerRecords(records){
        let arr  = [],
            data = [];
        // Consolidate amount using TICK-ADDRESS as key
        for(let idx in records){
            let [tick, amount, address] = records[idx];
            let key = tick + '-' + address;
            arr[key] = (arr[key]) ? String(this.bcnum(arr[key]) + this.bcnum(amount)) : amount; 
        }
        // Build out array of consolidated records
        for(let key in arr){
            let amount = arr[key];
            let [tick, address] = String(key).split('-');
            let info = [tick, amount, address];
            data.push(info);
        }
        return data;
    }

    // Handle getting the default EXPIRATION 
    getDefaultExpiration(){
        // Get current time in seconds
        let now = this.bcdiv(Date.now(), 1000, 0);
        // Get number of seconds in EXPIRATION_FEE_DEFAULT_DAYS
        let sec = this.bcmul(this.config['EXPIRATION_FEE_DEFAULT_DAYS'], 86400, 0);
        return this.bcadd(now, sec, 0);
    }

    // Create the basic fees object used to calculate platform transaction fees
    async createFeesObject(db, data, preferences){
        // TODO: Change TICK from GAS to XCHAIN
        let tick    = 'GAS';
        let tick_id = await db.getTickerId(tick);
        let fees = {
            ACTION_INDEX : data['ACTION_INDEX'],
            SOURCE       : data['SOURCE'],
            TICK         : tick,
            TICK_ID      : tick_id,
            AMOUNT       : 0,
            METHOD       : (preferences['FEE_PREFERENCE']==1) ? 1 : 2 // 1=Destroy, 2=Donate
        };
        return fees;
    }

    // Calculate Transaction fee based on number of database hits
    // TODO: Make this code modular, so we can configure fees on actions on a per-chain basis
    getTransactionFee(db_hits, tick){
        let cost = 1000,                              // Cost in sats per DB hit
            sats = this.bcmul(db_hits, cost , 0),     // FEE in sats (integer)
            fee  = this.bcmul(sats, '0.00000001', 8); // FEE in decimal (divisible)
        return fee;
    }

    // Calculate Transaction fee based on number of database hits
    getExpirationFee(data, info){
        let fee    = 0,
            format = data['FORMAT'];
        // Create Order / Swap / Dispenser
        if(format==0){
            let expire_seconds = this.bcsub(data['EXPIRATION'], data['BLOCK_TIME'], 0);
            let expire_days    = this.bcdiv(expire_seconds, 86400, 0);
            fee                = (expire_days > this.config['EXPIRATION_FEE_FREE_DAYS']) ? (this.bcmul(expire_days, this.config['EXPIRATION_FEE_PER_DAY'],8)) : 0;
        }
        // Edit Order / Swap /Dispenser
        if(format==2 && data['EXPIRATION'] > info['EXPIRATION']){
            let orig_expire_seconds = this.bcsub(info['EXPIRATION'], info['BLOCK_TIME'], 0);
            let orig_expire_days    = this.bcdiv(orig_expire_seconds, 86400, 0);
            let edit_expire_seconds = this.bcsub(data['EXPIRATION'], info['BLOCK_TIME'], 0);
            let edit_expire_days    = this.bcdiv(edit_expire_seconds, 86400, 0);
            // Only calculate FEE if increasing EXPIRATION date and greater than EXPIRATION_FEE_FREE_DAYS
            if(data['EXPIRATION'] > info['EXPIRATION'] && edit_expire_days > this.config['EXPIRATION_FEE_FREE_DAYS']){
                let expire_days = this.bcsub(edit_expire_days, orig_expire_days, 0);
                fee             = this.bcmul(expire_days, this.config['EXPIRATION_FEE_PER_DAY'],8);
            }
        }
        return fee;
    }

    // Determine if a tx hash is valid or not
    // TODO: clean this up to verify it is an actual tx hash
    isValidTransactionHash(hash){
        if(String(hash).length==64)
            return 1;
        return 0;
    }

    // Determine price of an item (numerator / denominator)
    // Note : Use precision up to 64 decimals points for very precise prices
    getPrice(numerator, denominator, precision=64){
        return this.bcdiv(numerator, denominator, precision);
    }

    // Handle sorting an array of objects by price, then by action_index
    sortPriceActionIndex(data){
        data.sort((a, b) => {
            // First, sort by 'GET_PRICE' in ascending order
            if(a['GET_PRICE'] > b['GET_PRICE'])
                return -1;
            if(a['GET_PRICE'] < b['GET_PRICE'])
                return 1;
            // Second, sort by 'ACTION_INDEX' in ascending order
            if(a['ACTION_INDEX'] > b['ACTION_INDEX'])
                return -1;
            if(a['ACTION_INDEX'] < b['ACTION_INDEX'])
                return 1;
            // If GET_PRICE and ACTION_INDEX are equal, maintain original order
            return 0;
        });
        return data;
    }

    // Process any transaction FEE according the user's ADDRESS preferences
    async processTransactionFees(db, credits, debits, fees){
        if(fees['AMOUNT']>0){
            // Debit FEE from SOURCE
            debits.push([fees['TICK'], fees['AMOUNT'], fees['SOURCE']]);
            // Handle using FEE according the the users ADDRESS preferences
            if(fees['METHOD']>1){
                // Short alias to config addresses
                let address = this.config['ADDRESS'];
                // Determine what address to donate to
                fees['DESTINATION'] = (fees['METHOD']==2) ? address['DONATE1'] : address['DONATE2'];
                // Store the donation ADDRESS and TICK in addresses list
                this.addAddressTicker(fees['DESTINATION'], fees['TICK']);
                // Credit donation address with FEE
                credits.push([fees['TICK'], fees['AMOUNT'], fees['DESTINATION']]);
            } 
            // Create record of FEE in `fees` table
            await db.createFeeRecord(fees);
        }
        // Return updated list of credits and debits
        return [credits, debits];
    }

    // Process any transaction ledger changes (credits / debits / escrows)
    async processTransactionLedgerChanges(db, data, credits, debits, escrows){
        // Consolidate the credit / debit / escrow records to write as few records as possible
        debits  = this.consolidateLedgerRecords(debits);
        credits = this.consolidateLedgerRecords(credits);
        escrows = this.consolidateLedgerRecords(escrows);
        let action_index = data['ACTION_INDEX'];
        // Create records in debits table
        for(let idx in debits){
            let [tick, amount, address] = debits[idx];
            await db.createDebit(action_index, tick, amount, address);
        }
        // Create records in credits table
        for(let idx in credits){
            let [tick, amount, address] = credits[idx];
            await db.createCredit(action_index, tick, amount, address);
        }
        // Create records in escrows table
        for(let idx in escrows){
            let [tick, amount, address] = escrows[idx];
            await db.createEscrow(action_index, tick, amount, address);
        }
    }

    // Process any orders, swaps, or dispensers which are past expiration 
    // NOTE: We currently use block_time to expire items... not ideal as block times can be manipulated
    // TODO: Revisit this code and handle calculating block time more elegantly
    async processExpirations(actions, db, block_index, block_time){
        let expired = await db.getExpiredItems(block_time);
        for(let info of expired){
            // Define basic ACTION transaction data object
            let action = String(info.type + '_EXPIRE').toUpperCase();
            let data = {};
            data['ACTION']       = action;
            data['BLOCK_INDEX']  = block_index;
            data['BLOCK_TIME']   = block_time;
            data['ACTION_INDEX'] = info.action_index;
            await actions.processAction(action, null, data, null);
        }
    }    
}

module.exports = Utility;
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

// Address encoding constants and per-coin network parameters
// Base58 version bytes and bech32 HRPs mirror the network definitions used by
// the coin daemons (and the encoder's CryptoNetworks). DOGE has no segwit, so
// no HRP. DOGE/LTC regtest reuse Bitcoin-testnet base58 prefixes by design.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET  = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST    = 1;          // BIP-173 checksum constant (segwit v0)
const BECH32M_CONST   = 0x2bc830a3; // BIP-350 checksum constant (segwit v1+)
const ADDRESS_PARAMS  = {
    BTC: {
        mainnet: { p2pkh: 0x00, p2sh: 0x05, hrp: 'bc'   },
        testnet: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'tb'   },
        regtest: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'bcrt' }
    },
    LTC: {
        mainnet: { p2pkh: 0x30, p2sh: 0x32, hrp: 'ltc'  },
        testnet: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'tltc' },
        regtest: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'rltc' }
    },
    DOGE: {
        mainnet: { p2pkh: 0x1e, p2sh: 0x16, hrp: null },
        testnet: { p2pkh: 0x71, p2sh: 0xc4, hrp: null },
        regtest: { p2pkh: 0x6f, p2sh: 0xc4, hrp: null }
    }
};


class Utility {

    constructor(){
        // Track addresses/tickers/transactions across an action parse
        this.addresses = {}; // this.addresses[address] = [tick, tick, tick];
        this.tickers   = [];

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

    // Safely convert a value to string; returns null if the value can't be converted.
    // mathjs bignumbers serialize via String() in scientific notation for very small
    // / very large magnitudes ("3e-8" for 0.00000003), which breaks downstream string
    // comparisons against the wire-format value. Format bignumbers in fixed notation.
    // (We don't pass a `precision` arg, because that would also right-pad trailing zeros
    // that may or may not have been present in the original. Callers that care about
    // a specific digit count should normalize at write time.)
    safeToString(val) {
        if(val === null || val === undefined)
            return null;
        if(typeof val !== 'object')
            return String(val);
        if(mathjs.isBigNumber && mathjs.isBigNumber(val))
            return mathjs.format(val, {notation: 'fixed'});
        if(typeof val.toString !== 'function')
            return null;
        try { return String(val); } catch(e){ return null; }
    }

    // Run a promise with a timeout; rejects with an error if the promise doesn't resolve in time
    withTimeout(promise, ms, label) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Watchdog timeout: ' + (label || 'operation') + ' exceeded ' + ms + 'ms')), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    // Throw an error and log to console
    throwError(error){
        console.error('throwError:', error);
        throw error;
    }

    // Log an error to the error.log file
    logError(error, info){
        console.error('logError: ' + error, info);
    }

    // JSON.stringify with BigInt support
    jsonStringify(obj){
        return JSON.stringify(obj, (key, value) => typeof value === 'bigint' ? value.toString() : value);
    }

    // Get a SHA256 hash of a given data object
    getDataHash(data){
        let obj  = Object.assign({}, data); // Convert data to object if not already
        let json = this.jsonStringify(obj);
        let hash = crypto.createHash('sha256').update(json).digest('hex');
        return hash;
    }

    // Map a raw VM execution error ("revert: ...", "out_of_gas: ...", "timeout: ...",
    // "out_of_resource: ...", "error: ...") to a deterministic, consensus-stable status
    // token. The token is interned in index_statuses and hashed into contract_hash (via
    // the resolved status string s1.status in db.getBlockHashes), so it MUST be a pure
    // function of consensus inputs.
    //
    // The resource-exhaustion family (out_of_gas / timeout / out_of_memory / out_of_stack /
    // out_of_resource) collapses to ONE token. out_of_gas was once kept distinct on the
    // assumption it is "deterministically gas-bounded", but that has a hole: a contract
    // burning gas in a tight loop races the gas ceiling (deterministic) against the
    // wall-clock safety net (host-speed/-load dependent). On a fast validator gas wins
    // ("out_of_gas: ..."); on a slow/loaded one the wall-clock net wins ("timeout: ...").
    // Mapping them to distinct tokens lets two honest validators record different status_ids
    // for the same contract+gas-schedule → divergent contract_hash → chain fork. WHICH
    // ceiling fires is not a consensus input, so it must not affect the token. gasUsed is
    // already clamped to the ceiling on every path, so the fee stays fork-safe; the raw
    // out_of_gas-vs-timeout detail is preserved (un-hashed) in contract_executions.error_message.
    // reverted (contract-controlled) and failed (deterministic runtime throw) stay distinct;
    // they are not host-timing races.
    //
    // The family regex MUST stay identical to the gas-clamp regex in actions/execute.js and
    // actions/deploy.js so the status mapping and the fee clamp can never drift to different
    // family definitions.
    //
    // FROZEN VOCABULARY: the returned tokens are the closed set
    // xchain-vm/src/consensus-runtime.js CONSENSUS_STATUS_TOKENS. Adding/splitting a token is a
    // consensus change (bump CONSENSUS_VERSION). Guarded by test/unit/consensus-params.test.js.
    vmFailureStatus(vmError){
        let msg = String(vmError || '');
        if(msg.startsWith('revert:')) return 'reverted';
        if(/^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(msg)) return 'out_of_resource';
        return 'failed';
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

    // Create nice human readable time string based on milliseconds
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
        if(value === null || value === undefined)
            return false;
        // Allow objects with numeric conversion (e.g. mathjs bignumber) but reject broken ones
        if(typeof value === 'object'){
            if(typeof value.toNumber === 'function')
                return Number.isInteger(value.toNumber());
            return false;
        }
        return Number.isInteger(+value);
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

    // Handle converting a string number to a mathjs bignumber for full precision
    bcnum(num){
        let str = String(num).trim();
        if(str === 'NaN' || str === 'Infinity' || str === '-Infinity' || !this.isNumeric(num))
            return mathjs.bignumber(0);
        return mathjs.bignumber(str);
    }

    // Handle returning a number to a given decimal point precision
    bcformat(num, decimals){
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(this.bcnum(num),{notation: 'fixed', precision: d});
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

    // Multiply two bignumber strings and floor the result to d decimal places.
    // Uses Decimal.js native .floor() (via bcnum) to avoid mathjs.format()'s
    // banker's rounding, which rounds half-to-even and can credit holders more
    // than their strict proportional entitlement at midpoint fractional values.
    bcmulfloor(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        let product = mathjs.multiply(mathjs.bignumber(a), mathjs.bignumber(b));
        let scale = mathjs.bignumber(10).pow(d);
        let floored = this.bcnum(product).times(scale).floor().div(scale);
        return this.bcnum(mathjs.format(floored, {notation: 'fixed', precision: d}));
    }

    // Round a bignumber to d decimal places, half-up, entirely in decimal.js space.
    // Implemented as floor(n * 10^d + 0.5) / 10^d so the rounding mode is explicit and
    // config-independent: it does NOT depend on the global decimal.js/mathjs rounding
    // setting (the same determinism concern that motivated bcmulfloor and the exact bc*
    // comparators). Used to snap a derived settlement amount onto its tick's decimal grid:
    // it recovers the true value from sub-ULP precision artifacts (e.g. 1 − 1e-18 =
    // 0.999999999999999999 → 1) and forces indivisible (0-decimal) tokens to integers.
    bcround(num, decimals){
        let n = (!this.isNull(num)) ? num : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        let scale   = mathjs.bignumber(10).pow(d);
        let half    = mathjs.bignumber('0.5');
        let rounded = this.bcnum(n).times(scale).plus(half).floor().div(scale);
        return this.bcnum(mathjs.format(rounded, {notation: 'fixed', precision: d}));
    }

    // Handle dividing 2 big numbers
    bcdiv(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        if(String(b) === '0' || b === 0)
            return mathjs.bignumber(0);
        return this.bcnum(mathjs.format(mathjs.divide(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Floor a bignumber to a JS integer in bignumber space; avoids the
    // Math.floor(Number(bignumber)) trap where the implicit Number() coercion
    // goes through IEEE 754 and can round a value like 2.9999…964 down to 2
    // instead of returning the correct 3. Note: uses decimal.js's native
    // .floor(), NOT mathjs.floor() (the latter is configured with a default
    // precision that rounds 137.99999999999 up to 138.
    bcfloor(num){
        return this.bcnum(num).floor().toNumber();
    }

    // Handle comparing two big numbers: returns true if numA > numB
    //
    // Uses decimal.js's native .gt/.lt/.gte/.lte (exact) rather than
    // mathjs.larger/smaller/largerEq/smallerEq, which apply mathjs's comparison
    // epsilon (~1e-12) and treat any two amounts differing by less than that as
    // EQUAL. For 18-decimal tokens that silently corrupts every comparison of
    // sub-1e-12 amounts: e.g. bcgt('0.000000000000001', '0') returned false,
    // so a dust balance read as "not greater than zero". These must be exact.
    bcgt(numA, numB){
        return this.bcnum(numA).gt(this.bcnum(numB));
    }

    // Handle comparing two big numbers: returns true if numA < numB
    bclt(numA, numB){
        return this.bcnum(numA).lt(this.bcnum(numB));
    }

    // Handle comparing two big numbers: returns true if numA >= numB
    bcgte(numA, numB){
        return this.bcnum(numA).gte(this.bcnum(numB));
    }

    // Handle comparing two big numbers: returns true if numA <= numB
    bclte(numA, numB){
        return this.bcnum(numA).lte(this.bcnum(numB));
    }

    // Validate if a given value is considered valid
    // @value = string or integer or bignumber
    // @valid = string or array of values
    isValidValue(value, valid){
        let valueType = typeof value,
            validType = typeof valid;
        // Convert bignumber objects to their numeric value
        if(valueType=='object' && value !== null && typeof value.toNumber === 'function')
            value = value.toNumber();
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
    isValidAmountFormat(decimals, amount){
        // Reject objects that can't be safely converted to string
        if(amount !== null && amount !== undefined && typeof amount === 'object' && this.safeToString(amount) === null)
            return false;
        // Reject negative amounts
        if(String(amount).startsWith('-'))
            return false;
        // Determine divisibility and default to true
        let divisible   = (parseInt(decimals)==0) ? false : true;
        let [int, sats] = String(amount).split('.');
        if(!divisible && this.isNumeric(int) && int==amount)
            return true;
        if(divisible && this.isNumeric(int) && (this.isNull(sats) || this.isNumeric(sats)))
            return true;
        return false;
    }

    // Handle validating fiat amount format
    isValidFiatFormat(decimals, amount){
        let valid = this.isValidAmountFormat(decimals, amount);
        if(valid){
            let [int, sats] = String(amount).split('.');
            if(!this.isNull(sats) && String(sats).length > decimals)
                valid = false;
        }
        return valid;
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

    // Decode a base58check string and return its payload bytes, or false if the
    // string is not valid base58check (bad charset, bad length, bad checksum)
    base58CheckDecode(address){
        let str = String(address);
        // Reject anything outside the plausible base58check address length band
        if(str.length<26 || str.length>48)
            return false;
        // Decode base58 to a big integer, rejecting any out-of-alphabet character
        let num = 0n;
        for(let char of str){
            let value = BASE58_ALPHABET.indexOf(char);
            if(value==-1)
                return false;
            num = num * 58n + BigInt(value);
        }
        // Convert integer to bytes, restoring leading zero bytes (leading '1' chars)
        let hex = num.toString(16);
        if(hex.length % 2)
            hex = '0' + hex;
        let bytes = Buffer.from(hex,'hex');
        if(num==0n)
            bytes = Buffer.alloc(0);
        let leading = 0;
        while(leading<str.length && str[leading]=='1')
            leading++;
        let data = Buffer.concat([Buffer.alloc(leading), bytes]);
        // Last 4 bytes are a double-SHA256 checksum over the payload
        if(data.length<5)
            return false;
        let payload  = data.subarray(0, data.length-4);
        let checksum = data.subarray(data.length-4);
        let hash = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest();
        if(!hash.subarray(0,4).equals(checksum))
            return false;
        return payload;
    }

    // Decode a bech32/bech32m string (BIP-173/BIP-350) and return
    // { hrp, version, program } for a valid segwit address, or false
    bech32Decode(address){
        let str = String(address);
        // Reject mixed case, then work in lowercase (all-uppercase is allowed)
        if(str!=str.toLowerCase() && str!=str.toUpperCase())
            return false;
        str = str.toLowerCase();
        if(str.length<8 || str.length>90)
            return false;
        // Split on the last '1' separator
        let pos = str.lastIndexOf('1');
        if(pos<1 || pos+7>str.length)
            return false;
        let hrp  = str.substring(0,pos);
        let data = [];
        for(let char of str.substring(pos+1)){
            let value = BECH32_CHARSET.indexOf(char);
            if(value==-1)
                return false;
            data.push(value);
        }
        // Verify the BCH checksum (BIP-173 polymod over expanded hrp + data)
        let chk = 1;
        let values = [];
        for(let i=0; i<hrp.length; i++)
            values.push(hrp.charCodeAt(i)>>5);
        values.push(0);
        for(let i=0; i<hrp.length; i++)
            values.push(hrp.charCodeAt(i)&31);
        values = values.concat(data);
        const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        for(let value of values){
            let top = chk>>25;
            chk = ((chk&0x1ffffff)<<5)^value;
            for(let i=0; i<5; i++)
                if((top>>i)&1)
                    chk ^= GEN[i];
        }
        // Witness version is the first data value; remaining values (minus the
        // 6 checksum chars) are the witness program in 5-bit groups
        let version = data[0];
        if(version>16)
            return false;
        // Segwit v0 uses the bech32 constant, v1+ uses bech32m (BIP-350)
        if(chk!=(version==0 ? BECH32_CONST : BECH32M_CONST))
            return false;
        // Convert the witness program from 5-bit to 8-bit groups (no padding bits set)
        let bits = 0, acc = 0, program = [];
        for(let value of data.slice(1, data.length-6)){
            acc  = (acc<<5)|value;
            bits += 5;
            while(bits>=8){
                bits -= 8;
                program.push((acc>>bits)&0xff);
            }
        }
        if(bits>=5 || ((acc<<(8-bits))&0xff))
            return false;
        // Witness program length rules (BIP-141): 2-40 bytes, v0 exactly 20 or 32
        if(program.length<2 || program.length>40)
            return false;
        if(version==0 && program.length!=20 && program.length!=32)
            return false;
        return { hrp: hrp, version: version, program: program };
    }

    // Handle validating that an address is a real crypto address on the given
    // COIN + NETWORK (defaults to the configured COIN/NETWORK; pass a coin
    // explicitly for cross-chain destinations like a SWAP GET_ADDRESS).
    // Performs full base58check (version byte + checksum) and bech32/bech32m
    // validation so checksum typos and wrong-network addresses are rejected
    // instead of becoming unspendable destinations.
    isCryptoAddress(address, coin, network){
        if(this.isNull(address))
            return false;
        let coins  = ADDRESS_PARAMS[(coin) ? coin : this.config['COIN']];
        let params = (coins) ? coins[(network) ? network : this.config['NETWORK']] : false;
        if(!params)
            return false;
        let str = String(address);
        // Segwit address (only on coins with a bech32 HRP, e.g. not DOGE)
        if(params.hrp && str.toLowerCase().startsWith(params.hrp + '1')){
            let decoded = this.bech32Decode(str);
            return (decoded && decoded.hrp==params.hrp) ? true : false;
        }
        // Base58check address (P2PKH / P2SH): payload is version byte + hash160
        let payload = this.base58CheckDecode(str);
        if(!payload || payload.length!=21)
            return false;
        return (payload[0]==params.p2pkh || payload[0]==params.p2sh);
    }

    // Detect a contract's derived ledger address (e.g. "C:BTC:500"). Contracts ARE
    // valid on-ledger balance holders, so this format is a legitimate recipient
    // wherever proceeds settle purely on the XChain ledger (e.g. the GET_ADDRESS of a
    // same-chain token ORDER). It is NOT a real on-chain address: callers MUST keep
    // rejecting it anywhere native coin must actually be paid out (every DISPENSER,
    // and the native-coin side of an ORDER), since a synthetic address can't receive
    // a UTXO. Format-only check; see contract address derivation in
    // actions/execute.js (`'C:' + CHAIN + ':' + index`).
    isContractAddress(address){
        return /^C:[A-Z]+:[0-9]+$/.test(String(address));
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
        if(this.bcgte(balance, amount))
            return true;
        return false;
    }

    // Handle deducting TICK AMOUNT from balances and return updated balances array
    debitBalances(balances, tick_id, amount){
        let balance = (!this.isNull(balances[tick_id])) ? balances[tick_id] : 0;
        balances[tick_id] = this.bcsub(balance, amount, 18);
        return balances;
    }

    // Consolidate ledger records (credits / debits / escrows)
    consolidateLedgerRecords(records){
        let arr  = [],
            data = [];
        // Consolidate amount using TICK\0ADDRESS as key (\0 cannot appear in tick names or addresses)
        for(let idx in records){
            let [tick, amount, address] = records[idx];
            let key = tick + '\0' + address;
            arr[key] = (arr[key]) ? this.bcadd(arr[key], amount, 18) : amount;
        }
        // Build out array of consolidated records
        for(let key in arr){
            let amount = arr[key];
            let [tick, address] = String(key).split('\0');
            let info = [tick, amount, address];
            data.push(info);
        }
        return data;
    }

    // Handle getting the default EXPIRATION
    getDefaultExpiration(block_time){
        // Get current time in seconds
        let now = block_time;
        // Get number of seconds in EXPIRATION_FEE_DEFAULT_DAYS
        let sec = this.bcmul(this.config['EXPIRATION_FEE_DEFAULT_DAYS'], 86400, 0);
        return this.bcadd(now, sec, 0);
    }

    // Create the basic fees object used to calculate platform transaction fees
    async createFeesObject(db, data, preferences){
        let tick    = this.config['GAS'];
        let tick_id = await db.getTickerId(tick);
        let fees = {
            ACTION_INDEX : data['ACTION_INDEX'],
            SOURCE       : data['SOURCE'],
            TICK         : tick,
            TICK_ID      : tick_id,
            AMOUNT       : 0,
            METHOD       : (preferences['FEE_PREFERENCE']==1) ? 1 : 2, // 1=Destroy, 2=Donate
            // Unified gas fields (populated when UNIFIED_FEES is active)
            GAS_COST     : 0,
            GAS_PRICE    : this.config['GAS_PRICE'] || '0.00001',
            PAYMENT_MODE : 2, // 2=xchain_balance (Track A default)
            FEE_VERSION  : 1  // 1=legacy, updated to 2 when unified fees active
        };
        return fees;
    }

    // Calculate Transaction fee based on number of database hits (legacy)
    getTransactionFee(db_hits, tick){
        let cost = 1000,                              // Cost in sats per DB hit
            sats = this.bcmul(db_hits, cost , 0),     // FEE in sats (integer)
            fee  = this.bcmul(sats, '0.00000001', 8); // FEE in decimal (divisible)
        return fee;
    }

    // Per-tx protocol fee for a possibly-emitted action. VM-emitted actions (synthesized
    // inside an EXECUTE, flagged IS_EMISSION) pay no separate per-tx fee: the VM already
    // charges VM_EMISSION gas to the EXECUTE caller, and the fee model validates against the
    // EXECUTE tx's fee-destination outputs, which don't belong to a synthesized action (no
    // native fee output, and the contract SOURCE need not hold XCHAIN). Returns the computed
    // fee for normal on-wire actions, 0 for emissions. Mirrors execute.js's
    // `skipFee = Boolean(IS_EMISSION)`. NOTE: this is the per-tx processing fee only; it does
    // NOT cover deliberate economic fees (e.g. the ISSUE issuance fee), which are left intact.
    feeForAction(amount, data){
        return (data && data['IS_EMISSION']) ? '0' : amount;
    }

    // Resolve the consensus-critical controller-guard gas ceiling from the gas schedule.
    // VM_GUARD_GAS_CEILING bounds the guard fee reserved/billed against SOURCE and is
    // committed into the ledger/contract hashes, so a node that silently fell back to a
    // hard-coded default (because its GAS_SCHEDULE omits or mistypes the key) would bill a
    // different amount than a correctly configured node and fork on the first guarded action
    // after the CONTROLLER_GUARD flag-day. Treat it as a canonical key: validate (positive
    // integer, no trailing garbage) and throw loudly rather than mint a phantom default.
    // Read once via this single resolver at every guard-fee site so the two cannot drift.
    resolveGuardGasCeiling(config){
        let schedule = (config && config['GAS_SCHEDULE']) || {};
        let raw = schedule['VM_GUARD_GAS_CEILING'];
        let val = parseInt(raw, 10);
        if(raw === undefined || raw === null || !Number.isInteger(val) || val <= 0 || String(raw).trim() !== String(val)){
            throw new Error('GAS_SCHEDULE.VM_GUARD_GAS_CEILING missing or invalid (expected a positive integer, got ' + JSON.stringify(raw) + ')');
        }
        return val;
    }

    // Calculate Transaction fee using unified gas schedule (per-recipient)
    getUnifiedTransactionFee(recipients, gasType){
        let schedule  = this.config['GAS_SCHEDULE'];
        let gasPerRecipient = schedule[gasType] || 100;
        let gasCost   = this.bcmul(recipients, gasPerRecipient, 0);
        let fee       = this.bcmul(gasCost, this.config['GAS_PRICE'], 8);
        return { gasCost: gasCost, fee: fee };
    }

    // Flat premium charged when an ORDER/SWAP/DISPENSER create escrows ownership of a tick.
    // Added on top of the expiration fee in the UNIFIED_FEES path; legacy fees do not charge it.
    getOwnershipEscrowFee(){
        let schedule = this.config['GAS_SCHEDULE'];
        let gasCost  = schedule.OWNERSHIP_ESCROW || 0;
        let fee      = this.bcmul(gasCost, this.config['GAS_PRICE'], 8);
        return { gasCost: gasCost, fee: fee };
    }

    // Detect fee payment mode from the transaction
    // Returns: 'native' if fee output present, 'xchain' if absent on BTC, 'rejected' if absent on LTC/DOGE
    detectFeePaymentMode(data, decoderDb, txOutputs){
        // Emitted/synthesized actions (IS_EMISSION: VM emissions, XEXEC, ATTEST
        // responses) have no transaction of their own, so they can never carry a
        // native fee output. Their economic fee is paid from the emitting
        // contract's XCHAIN balance on EVERY chain (including LTC/DOGE, where a
        // top-level action with no fee output is rejected. Without this, a
        // contract-emitted ISSUE (or any emitted economic-fee action) is
        // unconditionally rejected on LTC/DOGE ('native coin output required'),
        // which BTC masks via its own xchain fallback below.
        if(data && data['IS_EMISSION']) return 'xchain';

        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        if(!feeDestination || feeDestination === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') {
            // No fee destination configured; fall back to xchain balance deduction
            return 'xchain';
        }

        // Check if any transaction output pays to the fee destination address
        let feeOutput = null;
        if(txOutputs && Array.isArray(txOutputs)){
            for(let output of txOutputs){
                if(output.address === feeDestination || output.scriptPubKey_address === feeDestination){
                    feeOutput = output;
                    break;
                }
            }
        }

        if(feeOutput){
            return 'native'; // Fee output found: native coin payment
        }

        // No fee output; implicit detection
        let coin = this.config['COIN'] || data['COIN'];
        if(coin === 'BTC'){
            return 'xchain'; // BTC allows XCHAIN balance deduction as fallback
        }

        // LTC/DOGE: native coin is the only option; missing fee output = rejected
        return 'rejected';
    }

    // Pure native-coin fee math, shared by validateNativeCoinFee (the on-chain consensus
    // check) and the read-only feequote pre-flight (Actions.computeFeeQuote). Keeping the
    // arithmetic in one place guarantees a client's output sizing and the validator's
    // acceptance test use identical numbers. USD intermediates are carried at 18-decimal
    // precision so the final native amount isn't biased by mid-computation truncation;
    // native-coin outputs are reported at satoshi (8-decimal) precision.
    // Returns { feeUsd, expectedNative, minAcceptable, maxAcceptable } (all bignumbers).
    computeNativeFeeBand(xchainAmount, xchainUsdPrice, coinUsdPrice, toleranceMin, toleranceMax){
        let feeUsd         = this.bcmul(xchainAmount, xchainUsdPrice, 18);
        let expectedNative = this.bcdiv(feeUsd, coinUsdPrice, 18);
        let minAcceptable  = this.bcmul(expectedNative, toleranceMin, 8);
        let maxAcceptable  = this.bcmul(expectedNative, toleranceMax, 8);
        return { feeUsd, expectedNative, minAcceptable, maxAcceptable };
    }

    // Fetch + validate the two oracle prices a native-coin fee is valued against
    // (COIN/USD and XCHAIN/USD), gated by blockIndex so two nodes see the same price and
    // rejected when staler than maxAgeSeconds relative to refTime. Prefers the local hub DB
    // (where price_snapshots is synced from xchain-hub) when available. Shared by
    // validateNativeCoinFee and computeFeeQuote.
    // Returns { coinUsdPrice, xchainUsdPrice, oracleRound } on success, or { error } on
    // a missing/stale/invalid price.
    async getFeeOraclePrices(db, coin, blockIndex, refTime, maxAgeSeconds){
        let priceDb;
        if(db.indexer && db.indexer.hubDb){
            priceDb = db.indexer.hubDb;
        } else {
            // No hub DB connection configured; price_snapshots / oracle_prices are read from
            // the indexer's own database instead. This is the intended single-host setup (the
            // local DB holds the synced hub copy). In a distributed deployment it almost always
            // means HUB_DB_HOST / HUB_DB_NAME are unset or misconfigured, in which case fee
            // validation and FIAT settlement run against stale or empty local price data with
            // no error. Warn once so the misconfiguration is visible in logs.
            priceDb = db;
            if(!this._hubDbFallbackWarned){
                this._hubDbFallbackWarned = true;
                console.warn('WARNING: getFeeOraclePrices: no hub DB configured (HUB_DB_HOST/HUB_DB_NAME unset); ' +
                    'falling back to the local indexer DB for price_snapshots/oracle_prices. ' +
                    'Expected for single-host deployments; on a distributed node this means price data may be stale or absent.');
            }
        }
        let opts = { blockTime: refTime, maxAgeSeconds: maxAgeSeconds };

        let coinPriceData = await priceDb.getLatestPrice(coin + '/USD', blockIndex, opts);
        if(!coinPriceData || !coinPriceData.price)
            return { error: 'no current oracle price for ' + coin + '/USD (missing or stale beyond ' + maxAgeSeconds + 's)' };
        let coinUsdPrice = this.bcnum(coinPriceData.price);
        if(this.bclte(coinUsdPrice, 0))
            return { error: 'invalid oracle price for ' + coin + '/USD' };

        let xchainPriceData = await priceDb.getLatestPrice('XCHAIN/USD', blockIndex, opts);
        if(!xchainPriceData || !xchainPriceData.price)
            return { error: 'no current oracle price for XCHAIN/USD (missing or stale beyond ' + maxAgeSeconds + 's)' };
        let xchainUsdPrice = this.bcnum(xchainPriceData.price);
        if(this.bclte(xchainUsdPrice, 0))
            return { error: 'invalid oracle price for XCHAIN/USD' };

        return {
            coinUsdPrice:   coinUsdPrice,
            xchainUsdPrice: xchainUsdPrice,
            oracleRound:    coinPriceData.roundNumber
        };
    }

    // Validate a native coin fee output against oracle price
    // db parameter accepts the indexer DB or hub DB connection; if a hubDb is available
    // on the action context, callers should prefer it (price_snapshots lives in the local hub DB).
    // Returns: { valid, nativeCoinAmount, oracleRound, error }
    async validateNativeCoinFee(data, fees, db, txOutputs){
        let feeDestination = this.config['ADDRESS']['FEE_DESTINATION'];
        let toleranceMin = this.bcnum(this.config['FEE_TOLERANCE_MIN'] || '0.95');
        let toleranceMax = this.bcnum(this.config['FEE_TOLERANCE_MAX'] || '1.10');

        // Find the fee output
        let feeOutput = null;
        if(txOutputs && Array.isArray(txOutputs)){
            for(let output of txOutputs){
                if(output.address === feeDestination || output.scriptPubKey_address === feeDestination){
                    feeOutput = output;
                    break;
                }
            }
        }

        if(!feeOutput){
            return { valid: false, error: 'no fee output to FEE_DESTINATION' };
        }

        let paidAmount = this.bcnum(feeOutput.value || feeOutput.amount || 0);
        if(this.bclte(paidAmount, 0)){
            return { valid: false, error: 'fee output has zero value' };
        }

        // Get the XCHAIN fee amount (already calculated by the action handler)
        let xchainAmount = this.bcnum(fees['AMOUNT']);
        if(this.bclte(xchainAmount, 0)){
            // No fee required; accept
            return { valid: true, nativeCoinAmount: '0', oracleRound: 0 };
        }

        // Get oracle prices: XCHAIN/USD and COIN/USD.
        // Gate by BLOCK_INDEX so two nodes processing the same block see the same price, and
        // reject silently stale prices against the block's own timestamp (deterministic during
        // consensus replay); see db.getLatestPrice and getFeeOraclePrices.
        let coin = this.config['COIN'] || data['COIN'];
        let maxPriceAgeSeconds = parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800;
        let prices = await this.getFeeOraclePrices(db, coin, data['BLOCK_INDEX'], data['BLOCK_TIME'], maxPriceAgeSeconds);
        if(prices.error){
            return { valid: false, error: prices.error };
        }

        let band = this.computeNativeFeeBand(xchainAmount, prices.xchainUsdPrice, prices.coinUsdPrice, toleranceMin, toleranceMax);

        if(this.bclt(paidAmount, band.minAcceptable)){
            return { valid: false, error: 'insufficient native coin fee (paid: ' + this.bcformat(paidAmount, 8) +
                ', expected: ' + this.bcformat(band.expectedNative, 8) + ', min: ' + this.bcformat(band.minAcceptable, 8) + ')' };
        }

        return {
            valid:            true,
            nativeCoinAmount: this.bcformat(paidAmount, 8),
            nativeCoin:       coin,
            oracleRound:      prices.oracleRound,
            expectedAmount:   this.bcformat(band.expectedNative, 8)
        };
    }

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

    // Calculate expiration fee (legacy per-chain rate)
    getExpirationFee(data, info){
        let fee    = 0,
            format = data['FORMAT'];
        // Create Order / Swap / Dispenser
        if(format==0){
            let expire_seconds = this.bcsub(data['EXPIRATION'], data['BLOCK_TIME'], 0);
            let expire_days    = this.bcdiv(expire_seconds, 86400, 0);
            fee                = this.bcgt(expire_days, this.config['EXPIRATION_FEE_FREE_DAYS']) ? (this.bcmul(expire_days, this.config['EXPIRATION_FEE_PER_DAY'],8)) : 0;
        }
        // Edit Order / Swap / Dispenser
        if(format==2 && this.bcgt(data['EXPIRATION'], info['EXPIRATION'])){
            let orig_expire_seconds = this.bcsub(info['EXPIRATION'], info['BLOCK_TIME'], 0);
            let orig_expire_days    = this.bcdiv(orig_expire_seconds, 86400, 0);
            let edit_expire_seconds = this.bcsub(data['EXPIRATION'], info['BLOCK_TIME'], 0);
            let edit_expire_days    = this.bcdiv(edit_expire_seconds, 86400, 0);
            // Only calculate FEE if increasing EXPIRATION date and greater than EXPIRATION_FEE_FREE_DAYS
            if(this.bcgt(data['EXPIRATION'], info['EXPIRATION']) && this.bcgt(edit_expire_days, this.config['EXPIRATION_FEE_FREE_DAYS'])){
                let expire_days = this.bcsub(edit_expire_days, orig_expire_days, 0);
                fee             = this.bcmul(expire_days, this.config['EXPIRATION_FEE_PER_DAY'],8);
            }
        }
        return fee;
    }

    // Calculate expiration fee (unified gas schedule)
    getUnifiedExpirationFee(data, info){
        let schedule  = this.config['GAS_SCHEDULE'];
        let freeDays  = this.config['UNIFIED_EXPIRATION_FEE_FREE_DAYS'] || 90;
        let gasCost   = 0;
        let fee       = 0;
        let format    = data['FORMAT'];
        // Create Order / Swap / Dispenser
        if(format==0){
            let expire_seconds = this.bcsub(data['EXPIRATION'], data['BLOCK_TIME'], 0);
            let expire_days    = this.bcdiv(expire_seconds, 86400, 0);
            let chargeableDays = this.bcsub(expire_days, freeDays, 0);
            if(this.bcgt(chargeableDays, 0)){
                gasCost = this.bcmul(chargeableDays, schedule.EXPIRATION_PER_DAY, 0);
                fee     = this.bcmul(gasCost, this.config['GAS_PRICE'], 8);
            }
        }
        // Edit Order / Swap / Dispenser
        if(format==2 && info && this.bcgt(data['EXPIRATION'], info['EXPIRATION'])){
            let orig_expire_seconds = this.bcsub(info['EXPIRATION'], info['BLOCK_TIME'], 0);
            let orig_expire_days    = this.bcdiv(orig_expire_seconds, 86400, 0);
            let edit_expire_seconds = this.bcsub(data['EXPIRATION'], info['BLOCK_TIME'], 0);
            let edit_expire_days    = this.bcdiv(edit_expire_seconds, 86400, 0);
            if(this.bcgt(edit_expire_days, freeDays)){
                let additionalDays = this.bcsub(edit_expire_days, orig_expire_days, 0);
                gasCost = this.bcmul(additionalDays, schedule.EXPIRATION_PER_DAY, 0);
                fee     = this.bcmul(gasCost, this.config['GAS_PRICE'], 8);
            }
        }
        return { gasCost: gasCost, fee: fee };
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

    // Sort an object by key values
    ksort(obj){
        const sortedKeys = Object.keys(obj).sort();
        const sortedObj = sortedKeys.reduce((acc, key) => {
            acc[key] = obj[key];
            return acc;
        }, {});
        return sortedObj;
    }

    // Handle sorting an array of objects by price, then by action_index
    sortPriceActionIndex(data){
        data.sort((a, b) => {
            // First, sort by 'GET_PRICE' in ascending order
            if(this.bcgt(a['GET_PRICE'], b['GET_PRICE']))
                return -1;
            if(this.bclt(a['GET_PRICE'], b['GET_PRICE']))
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
        if(this.bcgt(fees['AMOUNT'], 0)){
            let paymentMode = fees['PAYMENT_MODE'] || 2;

            if(paymentMode === 1){
                // Native coin payment mode: fee is paid via on-chain output
                // No XCHAIN debit or credit; the native coin is already in the fee destination address
                // Just record the fee in the fees table
            } else {
                // XCHAIN balance deduction mode (default / Track A)
                debits.push([fees['TICK'], fees['AMOUNT'], fees['SOURCE']]);
                // Handle using FEE according the the users ADDRESS preferences
                if(fees['METHOD']>1){
                    let address = this.config['ADDRESS'];
                    fees['DESTINATION'] = (fees['METHOD']==2) ? address['DONATE1'] : address['DONATE2'];
                    this.addAddressTicker(fees['DESTINATION'], fees['TICK']);
                    credits.push([fees['TICK'], fees['AMOUNT'], fees['DESTINATION']]);
                }
            }

            // Create record of FEE in `fees` table
            await db.createFeeRecord(fees);
        }
        // Return updated list of credits and debits
        return [credits, debits];
    }

    // Transfer ownership of a tick from one address to another by clearing the ownership
    // escrow gate and writing a synthetic ISSUE+TRANSFER. `tokens.owner_id` is then
    // re-derived by db.updateTokens(). Called by order_match / swap_match / dispense /
    // coinpay / sweep when an ownership offer settles or is closed with delivery routing.
    async transferTokenOwnership(db, mapper, data, tick, fromAddress, toAddress){
        await db.clearTokenEscrow(tick);
        let issue = {
            ACTION:       'ISSUE',
            TICK:         tick,
            TRANSFER:     toAddress,
            SOURCE:       fromAddress,
            BLOCK_INDEX:  data['BLOCK_INDEX'],
            TX_INDEX:     data['TX_INDEX'],
            BLOCK_TIME:   data['BLOCK_TIME'],
            STATUS:       'valid'
        };
        issue['ACTION_INDEX'] = await db.createActionIndex(issue, true);
        await db.createIssue(issue);
        await db.updateTokens(tick);
        this.addAddressTicker(fromAddress, tick);
        this.addAddressTicker(toAddress,   tick);
        await mapper.createMappings(issue);
    }

    // Process any transaction ledger changes (credits / debits / escrows)
    /*****************************************************************
     * Programmable policy layer: shared controller-guard enforcement.
     ****************************************************************/

    // Static map from a native action (in its guarded context) to the controlled action-class.
    // Deliberately NOT derived from data['ACTION'] dynamically, so a newly added action can never
    // silently fall into a controlled class. An unmapped action returns null (never gated).
    controllerActionClass(actionType){
        switch(actionType){
            case 'SEND':             return 'transfer';
            case 'ORDER_CREATE':
            case 'SWAP_CREATE':
            case 'DISPENSER_CREATE': return 'trade';
            case 'DESTROY':          return 'burn';
            // Stubs: the class is reserved + routable, but no handler invokes the guard for these
            // yet (MINT supply creation / STAKE locking gating land in a later phase).
            case 'MINT':             return 'mint';
            case 'STAKE':            return 'stake';
            default:                 return null;
        }
    }

    // Run the bound controller's `guard` for one native action when the token has an effective
    // controller for the routed action-class. Single enforcement point called at each token
    // handler's validated→settlement boundary (replaces the per-handler ad-hoc veto blocks).
    // Returns { error, guardFee, payoutLegs }:
    //   - error      : non-null = DENY (caller leaves status as 'invalid: '+error, writes no ledger)
    //   - guardFee   : GAS to debit from SOURCE when the action proceeds (metered guard gas)
    //   - payoutLegs : reserved for the at-create royalty/fee split (Phase D; null here)
    // No controller, an unmapped class, or a self guard-of-guard emission → { null, 0, null }.
    async maybeRunControllerGuard(actions, db, opts){
        let none = { error: null, guardFee: 0, payoutLegs: null };
        let data = opts.data;
        let actionClass = this.controllerActionClass(opts.actionType);
        if(!actionClass) return none;
        // Resolve the token's effective controller for this class (append-only read-time cooldown).
        // Most-specific-wins: a class-specific binding overrides the catch-all 'all' binding.
        let tickId = await db.getTickerId(opts.tick);
        if(this.isNull(tickId)) return none;
        let effective = await db.getEffectiveTokenControllerForGuard(tickId, actionClass, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        if(!effective) return none;
        // Record that this tick's controller was consulted this action (PTLC completeness assertion).
        if(!data['_GUARDED_TICKS']) data['_GUARDED_TICKS'] = {};
        data['_GUARDED_TICKS'][String(opts.tick)] = true;
        return this._invokeController(actions, db, Number(effective.contract_index), opts);
    }

    // Recipient/account-side enforcement: run the SUBJECT address's controller for the given class
    // (opts.address + opts.actionClass). The contract bound to that account gates the action; e.g.
    // an incoming direct SEND the recipient didn't solicit (spam/compliance); refusal reverts it.
    // Resolves by address (address_controllers); same gas-reservation + guard-of-guard semantics.
    async maybeRunAddressControllerGuard(actions, db, opts){
        let none = { error: null, guardFee: 0, payoutLegs: null };
        if(!opts.actionClass) return none;
        let addressId = await db.getAddressId(opts.address);
        if(this.isNull(addressId)) return none;
        // Most-specific-wins: a class-specific binding overrides the catch-all 'all' binding.
        let effective = await db.getEffectiveAddressControllerForGuard(addressId, opts.actionClass, opts.data['BLOCK_INDEX'], opts.data['ACTION_INDEX']);
        if(!effective) return none;
        return this._invokeController(actions, db, Number(effective.contract_index), opts);
    }

    // Shared tail for both controller kinds: the guard-of-guard skip, the gas-ceiling reservation
    // against SOURCE, the VM guard run (fail-closed in runControllerGuard), and the fee derivation.
    async _invokeController(actions, db, controllerIndex, opts){
        let data = opts.data;
        // Activation gate (single shared chokepoint for both token- and address-controller
        // guards). Until the CONTROLLER_GUARD flag-day the guard is a strict no-op on every
        // node: no allow/deny VM run, no payout_legs, no guard contract_executions row, so a
        // node that lacks the controller layer and one that has it settle every guarded action
        // identically. This one check atomically gates the whole surface: the VM allow/deny in
        // runControllerGuard, the payout_legs column write in order.js/swap.js, the match-time
        // applyProceedsSplit in order_match.js/swap_match.js (which read the stored, now always
        // null pre-activation, payout_legs), and the guard-emission contract_hash contribution.
        // Without it the first guarded action forks the ledger and the federation checkpoint
        // preimage between heterogeneous node versions. See protocol_changes.js.
        if(!(await actions.protocolChanges.isEnabled('CONTROLLER_GUARD', data['BLOCK_INDEX'])))
            return { error: null, guardFee: 0, payoutLegs: null };
        // No guard-of-guard: a controller's own emission of the gated subject is not re-guarded;
        // cross-token / different-controller moves still guard, bounded by VM_MAX_CALL_DEPTH.
        if(data['IS_GUARD_EMISSION'] && Number(data['EMITTER']) === Number(controllerIndex))
            return { error: null, guardFee: 0, payoutLegs: null };
        // Reserve the guard gas ceiling against SOURCE's GAS balance (caller-pays-for-attempt) so a
        // cheap/denied guard can never drive GAS negative; the metered fee is billed by the caller.
        let guardCeiling = this.resolveGuardGasCeiling(db.config);
        let maxGuardFee  = this.bcmul(guardCeiling, db.config['GAS_PRICE'], 8);
        if(opts.gasInfo && this.bcgt(maxGuardFee, 0) && !this.hasBalance(opts.gasBalances, opts.gasInfo['TICK_ID'], maxGuardFee))
            return { error: 'insufficient funds (guard gas)', guardFee: 0, payoutLegs: null };
        let guard = await actions.actionExecute.runControllerGuard({
            actionType:      opts.actionType,
            controllerIndex: Number(controllerIndex),
            tick:            this.isNull(opts.tick)         ? '' : opts.tick,
            from:            this.isNull(opts.from)         ? '' : opts.from,
            to:              this.isNull(opts.to)           ? '' : opts.to,
            amount:          this.isNull(opts.amount)       ? '' : opts.amount,
            price:           this.isNull(opts.price)        ? '' : opts.price,
            proceedsTick:    this.isNull(opts.proceedsTick) ? '' : opts.proceedsTick,
            hostData:        data,
            callDepth:       (Number(data['CALL_DEPTH']) || 0) + 1,
            seq:             Number(opts.seq) || 0
        });
        if(!guard.allow)
            return { error: guard.reason, guardFee: 0, payoutLegs: null };
        return { error: null, guardFee: this.bcmul(guard.gasBilled, db.config['GAS_PRICE'], 8), payoutLegs: guard.payoutLegs || null };
    }

    // Programmable policy layer: apply a controlled-token sale's royalty/fee split to ONE proceeds
    // credit at match/dispense. `legs` is the stored split (JSON string or array of {to, bps}); each
    // leg takes bps/10000 of the ACTUAL fill `proceeds` (so partial fills split proportionally with no
    // stored-amount scaling). Returns the credit tuples [tick, amount, address] that REPLACE the single
    // full-proceeds credit: the seller's remainder FIRST, then one credit per non-zero leg. Conservation
    // is exact by construction (remainder = proceeds − Σlegs). A malformed or over-cap legs set yields
    // NO split (seller keeps full proceeds); defensive: a buggy/rogue controller can never trap or
    // inflate funds. `decimals` = the proceeds tick's precision; `maxTakeBps` caps Σbps (default 10000).
    applyProceedsSplit(tick, proceeds, sellerAddress, legs, decimals, maxTakeBps){
        let full = [[tick, proceeds, sellerAddress]];
        let parsed = legs;
        if(typeof legs === 'string'){
            try { parsed = JSON.parse(legs); } catch(e){ return full; }
        }
        if(!Array.isArray(parsed) || parsed.length === 0) return full;
        if(this.isNull(proceeds) || !this.bcgt(proceeds, '0')) return full;
        let dec = (Number.isInteger(decimals) && decimals >= 0) ? decimals : 8;
        let cap = (Number.isInteger(maxTakeBps) && maxTakeBps >= 0 && maxTakeBps <= 10000) ? maxTakeBps : 10000;
        // Validate every leg + sum the basis points (fail-closed: any malformed leg → no split).
        let totalBps = 0;
        for(let leg of parsed){
            let bps = (leg && this.isNumeric(leg.bps)) ? parseInt(leg.bps) : NaN;
            if(!Number.isInteger(bps) || bps < 0 || this.isNull(leg.to)) return full;
            totalBps += bps;
        }
        if(totalBps > cap || totalBps > 10000) return full;
        // Compute each leg deterministically: floor((proceeds * bps) / 10000) to tick precision.
        // MUST floor, not round: bcdiv rounds half-up, so multiple legs landing on a half-fraction
        // would each round UP and Σlegs could exceed proceeds, driving the seller's remainder
        // NEGATIVE (a conservation break + negative balance credit). bcmulfloor guarantees
        // distributed ≤ exact ≤ proceeds, so the remainder is always ≥ 0.
        let out = [];
        let distributed = '0';
        for(let leg of parsed){
            let bps = parseInt(leg.bps);
            if(bps === 0) continue;
            let amount = this.bcmulfloor(this.bcmul(proceeds, String(bps), dec + 4), '0.0001', dec);
            if(this.bcgt(amount, '0')){
                out.push([tick, amount, String(leg.to)]);
                distributed = this.bcadd(distributed, amount, dec);
            }
        }
        // Seller's remainder first (deterministic ordering); remainder absorbs the floored-away
        // fractions so the split conserves the proceeds exactly, and is always ≥ 0 (legs floored).
        let result = [[tick, this.bcsub(proceeds, distributed, dec), sellerAddress]];
        for(let c of out) result.push(c);
        return result;
    }

    async processTransactionLedgerChanges(db, data, credits, debits, escrows){
        // Programmable policy layer: completeness assertion (opt-in, test/audit only via
        // ASSERT_CONTROLLER_COMPLETENESS). Anti-drift backstop: if a transfer-controlled token is
        // debited from SOURCE but its controller was never consulted this action, a handler shipped
        // an ungated path. OFF by default so it can never affect production or the normal suite.
        if(db.config && db.config['ASSERT_CONTROLLER_COMPLETENESS'] && data && !data['IS_EMISSION'] && !data['IS_GUARD_EMISSION']){
            let guarded = data['_GUARDED_TICKS'] || {};
            for(let [tick, amount, address] of debits){
                if(address !== data['SOURCE']) continue;
                if(String(tick) === String(db.config['GAS'])) continue;
                if(!this.bcgt(amount, '0')) continue;
                let tickId = await db.getTickerId(tick);
                if(this.isNull(tickId)) continue;
                let eff = await db.getEffectiveTokenControllerForGuard(tickId, 'transfer', data['BLOCK_INDEX'], data['ACTION_INDEX']);
                if(eff && !guarded[String(tick)])
                    throw new Error('controller completeness: unguarded transfer-controlled debit of ' + tick + ' from SOURCE (action ' + data['ACTION_INDEX'] + ')');
            }
        }
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

    // Process any ATTEST v0 requests whose DEADLINE_BLOCK has passed without a
    // fulfilled response. Synthesizes one ATTEST v2 action per stale row; the
    // handler flips the request status to 'expired' and fires the callback with
    // status='expired' per framework spec §11.
    //
    // Driven by block_index (not block_time) because attestation deadlines are
    // measured in blocks, matching the wire format DEADLINE_BLOCKS.
    async processAttestationExpirations(actions, db, block_index, block_time){
        let expired = await db.getExpiredAttestationRequests(block_index);
        for(let info of expired){
            let data = {};
            data['ACTION']       = 'ATTEST';
            data['FORMAT']       = 2;
            data['BLOCK_INDEX']  = block_index;
            data['BLOCK_TIME']   = block_time;
            data['REQUEST_ID']   = info.request_id;
            data['IS_SYNTHETIC'] = true;
            // Mirror the synthetic-action positional layout: VERSION|REQUEST_ID
            await actions.processAction('ATTEST', [2, info.request_id], data, null);
        }
    }

    // Finalize unstakes (capability + contract) whose cooldown has elapsed.
    // For each completed row: writes a credit using the unstake's own action_index
    // (for audit-trail continuity), updates the source address's balance, and marks
    // the unstake row as 'completed' so the same release doesn't fire twice.
    //
    // Skips rows where amount=0 (fully slashed). Operates inside the block transaction
    // so the credit + balance update + status flip are all atomic with the block.
    async processCooldownCompletions(db, block_index){
        let sweep = await db.sweepCompletedCooldowns(block_index);
        if(!sweep || sweep.credits.length === 0) return;
        let addressesToRebalance = new Set();
        let ticksToRebalance     = new Set();
        // Apply credits: each tuple is [tick, amount, sourceAddress]
        // The credit's action_index reuses the unstake's action_index for the audit trail.
        // We need to associate each credit with the right row, so re-derive from sweep state.
        // capabilityRows and contractRows preserve action_index order; re-query for tick/amount/address.
        if(sweep.capabilityRows.length > 0 || sweep.contractRows.length > 0){
            // Re-fetch with action_index so each credit gets its own action_index trail
            let placeholdersCap = sweep.capabilityRows.map(() => '?').join(',');
            let placeholdersCon = sweep.contractRows.map(() => '?').join(',');
            if(sweep.capabilityRows.length > 0){
                let rows = await db.doQuery(
                    `SELECT u.action_index, u.amount, a.address AS source_address
                     FROM unstakes u
                         LEFT JOIN index_addresses a ON (a.id = u.source_id)
                     WHERE u.action_index IN (${placeholdersCap})`,
                    sweep.capabilityRows
                );
                let gas = db.config['GAS'];
                for(let row of rows){
                    if(!this.bcgt(row.amount, '0')) continue;
                    await db.createCredit(row.action_index, gas, String(row.amount), row.source_address);
                    addressesToRebalance.add(row.source_address);
                    ticksToRebalance.add(gas);
                }
            }
            if(sweep.contractRows.length > 0){
                let rows = await db.doQuery(
                    `SELECT cu.action_index, cu.amount, a.address AS source_address, t.tick AS tick
                     FROM contract_unstakes cu
                         LEFT JOIN index_addresses a ON (a.id = cu.source_id)
                         LEFT JOIN index_tickers   t ON (t.id = cu.tick_id)
                     WHERE cu.action_index IN (${placeholdersCon})`,
                    sweep.contractRows
                );
                for(let row of rows){
                    if(!this.bcgt(row.amount, '0')) continue;
                    await db.createCredit(row.action_index, row.tick, String(row.amount), row.source_address);
                    addressesToRebalance.add(row.source_address);
                    ticksToRebalance.add(row.tick);
                }
            }
        }
        // Update balances AND token supply for everything the release credits touched. The credit
        // is a net mint (the matching debit was burned at STAKE time), so tokens.supply must be
        // recomputed from the ledger or the per-block sanityCheck (ledger == supply == balances)
        // trips on the released tick and halts the indexer. Mirrors every other ledger-mutating path.
        if(addressesToRebalance.size > 0){
            await db.updateBalances(Array.from(addressesToRebalance));
            await db.updateTokens(Array.from(ticksToRebalance));
        }
        // Flip the unstake rows to 'completed' so they won't be swept again
        await db.markCooldownsCompleted(sweep.capabilityRows, sweep.contractRows, sweep.completedId);
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
        // Process expired COINPay obligations
        let expiredObligations = await db.getExpiredCoinpayObligations(block_time);
        for(let info of expiredObligations){
            let action = 'COINPAY_EXPIRE';
            let data = {};
            data['ACTION']       = action;
            data['BLOCK_INDEX']  = block_index;
            data['BLOCK_TIME']   = block_time;
            data['ACTION_INDEX'] = info.action_index;
            await actions.processAction(action, null, data, null);
        }
    }

    // Settle this chain's leg of any cross-chain DEX matches that are effective at or
    // before this block. Each match is a finalized, validator-signed record delivered via
    // the hub mirror; CROSS_SETTLE verifies the 2f+1 signatures and releases escrow to the
    // counterparty. Idempotent: getEffectiveUnsettledMatches excludes matches already in
    // cross_chain_settlements. The caller gates this on the match-sync barrier so every
    // operator of this chain settles the same matches at the same block.
    async processCrossChainSettlements(actions, db, block_index, block_time){
        let coin    = db.config['COIN'];
        let matches = await db.getEffectiveUnsettledMatches(coin, block_time);
        for(let m of matches){
            let data = {};
            data['ACTION']      = 'CROSS_SETTLE';
            data['BLOCK_INDEX'] = block_index;
            data['BLOCK_TIME']  = block_time;
            data['MATCH']       = m;
            await actions.processAction('CROSS_SETTLE', null, data, null);
        }
    }

    // Cross-chain contract call passes (all three are deterministic per block):
    //  1. TARGET side: inject XEXEC for every effective, unexecuted dispatch row
    //     targeting this chain, in (snapshot_block, call_id) order, capped per block
    //     (overflow carries forward to the next block; never dropped, or operators
    //     that raced different mirror states would diverge on the cutoff).
    //  2. SOURCE side: deliver every effective, unprocessed result row for a
    //     request this chain originated (verify sigs → exactly-once interlock →
    //     inject the requester's callback), in (snapshot_block, call_id) order under
    //     the same cap.
    //  3. SOURCE side: synthesize XCALL v2 for pending requests whose
    //     deadline_block has passed (block-height-driven, so expiry fires
    //     identically on every operator even with the hub down.
    // The caller gates this on the call-sync + snapshot barriers so every operator
    // applies the same rows at the same block.
    async processCrossChainCalls(actions, db, block_index, block_time){
        let coin    = db.config['COIN'];
        let network = db.config['NETWORK'];
        let cap     = require('./actions/xcall.js').XCALL_MAX_CALLS_PER_BLOCK;

        // 1. Inject executions for dispatches targeting this chain.
        let dispatches = await db.getEffectiveUndispatchedCalls(coin, network, block_time, cap);
        for(let c of dispatches){
            let data = {};
            data['ACTION']      = 'XEXEC';
            data['BLOCK_INDEX'] = block_index;
            data['BLOCK_TIME']  = block_time;
            data['CALL']        = c;
            await actions.processAction('XEXEC', null, data, null);
        }

        // 2. Deliver results for requests this chain originated, capped at
        // XCALL_MAX_CALLS_PER_BLOCK. Fetch the full effective set (the cap is applied here as
        // a deterministic slice) so step 3 can tell which requests already have a result
        // available this block even when the cap defers their delivery to a later block.
        let allResults = await db.getEffectiveUnprocessedCallResults(coin, network, block_time, Number.MAX_SAFE_INTEGER);
        let results = allResults.slice(0, cap);
        for(let r of results){
            let data = {};
            data['BLOCK_INDEX'] = block_index;
            data['BLOCK_TIME']  = block_time;
            await actions.actionXcall.processResult(r, data);
        }

        // 3. Expire pending requests past their deadline (mirrors processAttestationExpirations).
        // A quorum-signed result that is effective this block but deferred past the per-block cap
        // must still win over deadline expiry; otherwise the expiry pass flips the request to
        // 'expired' and the carried-over result later records skipped:expired, delivering the wrong
        // terminal status. Skip expiry for any request whose result is deliverable now (the full
        // effective set, not just the capped slice delivered this block).
        let deliverableIds = new Set(allResults.map(r => r.call_id));
        let expired = await db.getExpiredCrossChainCallRequests(block_index);
        for(let info of expired){
            if(deliverableIds.has(info.call_id)) continue; // effective result wins over expiry at this block
            let data = {};
            data['ACTION']       = 'XCALL';
            data['FORMAT']       = 2;
            data['BLOCK_INDEX']  = block_index;
            data['BLOCK_TIME']   = block_time;
            data['CALL_ID']      = info.call_id;
            data['IS_SYNTHETIC'] = true;
            await actions.processAction('XCALL', [2, info.call_id], data, null);
        }
    }

    // Process any dispensers which have been cancelled and need to be closed
    // NOTE: We currently use block_time to expire items... not ideal as block times can be manipulated
    // TODO: Revisit this code and handle calculating block time more elegantly
    async processCancellations(actions, db, block_index, block_time){
        let cancels = await db.findCancelledDispensers(block_time);
        for(let action_index of cancels){
            // Define basic ACTION transaction data object
            let action = 'DISPENSER_CLOSE';
            let data = {};
            data['ACTION']                 = action;
            data['BLOCK_INDEX']            = block_index;
            data['BLOCK_TIME']             = block_time;
            data['DISPENSER_ACTION_INDEX'] = action_index;
            data['DISPENSER_STATUS']       = 'cancelled';
            await actions.processAction(action, null, data, null);
        }
    }

    // Reverse price match for user TOKEN/FIAT oracles (PRICE v1)
    // Given a coin payment amount and a user oracle reference, find the most recent oracle
    // price within the window where the buyer can afford at least 1 token unit.
    //
    // The conversion uses BOTH a user oracle (TOKEN/FIAT) and a validator oracle (COIN/FIAT)
    // for the same FIAT currency:
    //   tokens_per_coin = (coin_amount × coin_fiat_price) / token_fiat_price
    //
    // Example: dispenser sells PEPECASH for BTC, denominated in JPY
    //   user oracle:      1 PEPECASH = ¥7.50
    //   validator oracle: 1 BTC      = ¥15,000,000
    //   payment:          0.001 BTC
    //   tokens = (0.001 × 15000000) / 7.50 = 2000 PEPECASH
    //
    // Returns { units, oraclePrice, coinFiatPrice } or null if no match found.
    async reverseOraclePriceMatch(coinAmount, oracleAddress, coin, tick, fiat, blockTime, priceWindow, db){
        let priceDb = (db.indexer && db.indexer.hubDb) ? db.indexer.hubDb : db;
        let startTime = blockTime - priceWindow;

        // Walk historical user oracle prices newest-first within the window
        let oraclePrices = await priceDb.getOraclePricesInTimeRange(oracleAddress, coin, tick, fiat, startTime, blockTime);
        if(!oraclePrices || oraclePrices.length === 0) return null;

        // For each historical oracle price, also fetch the validator's COIN/FIAT price at the same effective time
        let coinPair = coin + '/' + fiat;
        for(let op of oraclePrices){
            // Get the validator price at the time this oracle price was effective
            // (use the earliest available validator price at or before the oracle's effective_at)
            let validatorPrices = await priceDb.getPricesInTimeRange(coinPair, op.effectiveAt - priceWindow, op.effectiveAt);
            if(!validatorPrices || validatorPrices.length === 0) continue;
            let coinFiatPrice = validatorPrices[0].price;

            // Compute: tokens = (coin_amount × coin_fiat_price) / token_fiat_price
            let coinFiatTotal = this.bcmul(coinAmount, coinFiatPrice, 18);
            let rawTokens     = this.bcdiv(coinFiatTotal, op.price, 64);
            let units         = this.bcfloor(rawTokens);
            if(units >= 1){
                return {
                    units:         units,
                    oraclePrice:   op,
                    coinFiatPrice: coinFiatPrice
                };
            }
        }
        return null;
    }

    // Reverse price match for FIAT dispensers
    // Given a coin payment amount, find the most recent price snapshot where the buyer can afford at least 1 unit
    // Returns { units, snapshot } or null if no match found
    // Prefers the local hub DB (where price_snapshots is synced from xchain-hub) when available.
    async reversePriceMatch(coinAmount, fiatAmount, coinPair, blockTime, priceWindow, db){
        let startTime = blockTime - priceWindow;
        let priceDb = (db.indexer && db.indexer.hubDb) ? db.indexer.hubDb : db;
        let snapshots = await priceDb.getPricesInTimeRange(coinPair, startTime, blockTime);
        for(let snapshot of snapshots){
            // Calculate BTC cost per token unit at this snapshot's price
            // btc_per_token = fiat_amount / snapshot.price
            let btcPerToken = this.bcdiv(fiatAmount, snapshot.price, 18);
            // Calculate how many units the buyer's coin amount covers
            // raw_multiplier = coin_amount / btc_per_token
            let rawMultiplier = this.bcdiv(coinAmount, btcPerToken, 64);
            let units = this.bcfloor(rawMultiplier);
            if(units >= 1){
                return {
                    units:        units,
                    snapshot:     snapshot,
                    btcPerToken:  btcPerToken
                };
            }
        }
        return null;
    }

    // Handle checking if any sends were to an active dispenser address
    async processDispenserSends(actions, db, info){
        let sends = await db.findDispenserSends(info['ACTION_INDEX']);
        for(let send of sends){
            // Define basic DISPENSE transaction data object
            let action = 'DISPENSE';
            let data = {};
            data['ACTION']           = action;
            data['SOURCE']           = send.source;
            data['COIN']             = send.coin;
            data['COIN_TICK']        = send.tick
            data['COIN_AMOUNT']      = send.amount;
            data['COIN_DESTINATION'] = send.destination;
            data['BLOCK_INDEX']      = info['BLOCK_INDEX'];
            data['BLOCK_TIME']       = info['BLOCK_TIME'];
            data['TX_INDEX']         = info['TX_INDEX'];
            data['DISPENSE_TYPE']    = 'SEND';
            await actions.processAction(action, null, data, null);
        }
    }

    // Handle creating and updating DEX market information
    async processMarketUpdates(db, block_index, block_time){
        // Get list of market orders for the given block
        // Note: this also gets a list of any markets that have not had an update in the past 24 hours
        let markets = await db.getMarkets(block_index, true);
        // Process market pairs sequentially so that any new pair's row is
        // inserted in a deterministic order. createMarket() assigns an
        // AUTO_INCREMENT id on first insert; fanning the inserts out
        // concurrently let the id be assigned in DB-completion order, so two
        // nodes processing the same block could give the same pair different
        // ids. A serial loop pins the id to pair-iteration order on every node.
        for(let pair of markets){
            // Create market
            let market_id = await db.createMarket(pair.tick1_id, pair.tick2_id);
            // Get the market data
            let data = await db.getMarketInfo(market_id, block_time);
            // Set the last_updated time to the current block time
            data.last_updated = block_time;
            // Update market with the updated data
            await db.updateMarketInfo(data);
        }
    }


}

module.exports = Utility;
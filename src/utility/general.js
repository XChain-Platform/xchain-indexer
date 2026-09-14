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
 * XChain Indexer - Utility: lists, errors and timers
 *
 * The per-parse address/ticker lists, sleep and timeout helpers, error logging, the VM
 * failure status mapping and the debug timers.
 *
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');
const { getLogger } = require('../observability/index.js');

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    /*
     *  List management functions
     */

    // Reset the addresses list
    resetAddressesList(){
        this.addresses = {};
    },

    // Reset the tickers list
    resetTickersList(){
        this.tickers = [];
    },

    // Reset all the lists
    resetLists(){
        this.resetAddressesList();
        this.resetTickersList();
    },

    // Return list of addresses
    // FORMAT : address = [tick, tick, tick]
    getAddressesList(){
        return this.addresses;
    },

    // Return list of tickers
    getTickersList(){
        return this.tickers;
    },

    /* 
     * General utility functions
     */

    // Handle sleeping for a given number of milliseconds
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

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
    },

    // Run a promise with a timeout; rejects with an error if the promise doesn't resolve in time
    withTimeout(promise, ms, label) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Watchdog timeout: ' + (label || 'operation') + ' exceeded ' + ms + 'ms')), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    },

    // Throw an error and log to console
    throwError(error){
        getLogger().error('throwError:', error);
        throw error;
    },

    // Log an error to the error.log file
    logError(error, info){
        getLogger().error('logError: ' + error, info);
    },

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
    // xchain-vm/src/consensus_runtime.js CONSENSUS_STATUS_TOKENS. Adding/splitting a token is a
    // consensus change (bump CONSENSUS_VERSION). Guarded by test/unit/consensus_params.test.js.
    vmFailureStatus(vmError){
        let msg = String(vmError || '');
        if(msg.startsWith('revert:')) return 'reverted';
        if(/^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(msg)) return 'out_of_resource';
        return 'failed';
    },

    // Start a debug timer
    startTimer(){
        let now = Date.now();
        return now;
    },

    // get a timer using a given name
    getTimer(timer){
        let now = Date.now();
        let ms  = now - timer;
        let timeString = this.millisecondsToTimeString(ms);
        let niceString = ms + 'ms';
        if(timeString!='')
            niceString = timeString;
        return niceString;
    },

    // Log a timer using a given name (timeName : (timeString))
    logTimer(timer, timeName){
        var timeString = this.getTimer(timer);
        var niceString = (timeName!=null) ? timeName : 'Time';
        if(timeString!='')
            niceString += '\t: (' + timeString + ')';
        getLogger().info(niceString);
    },

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
};

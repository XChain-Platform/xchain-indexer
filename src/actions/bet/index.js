const { getLogger } = require('../../observability/index.js');
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
 * XChain Platform Action - BET
 *
 * Decentralized parimutuel betting. One self-contained action covers the whole market lifecycle: an
 * oracle creates a feed (a betting market defined fully on-chain), anyone
 * bets any live token on an outcome (escrowed at parse), the oracle resolves
 * after the deadline and the protocol pays winners pro-rata from the pot,
 * taking the oracle's percentage fee. Feeds are IMMUTABLE from create; the
 * pre-bet fix path is cancel + recreate. No resolve by expire_at = the
 * system BET_EXPIRE pass refunds every stake (see bet_expire.js and
 * Utility.processBetPasses).
 *
 * LAYOUT: this file holds the class, parse() and the per-format row writes.
 * The phases parse() calls live in bet/ by concern: create_feed.js (format 0
 * checks), validate.js (existing-feed and shared checks), fees.js and settle.js.
 *
 * PARAMS:
 * VERSION           - Format Version
 * LABEL             - Feed label (market title)
 * OUTCOMES          - Comma-separated outcome labels (2..MAX_BET_OUTCOMES)
 * TICK              - Ticker name or Ticker ID wagered (native coin rejects)
 * FEE               - Oracle fee as a PERCENT of the total pot (2dp; '1.00' = 1%)
 * DEADLINE          - Unix time betting closes and earliest resolve
 * REFUND_WINDOW     - Seconds after DEADLINE the oracle has to resolve
 * MIN_AMOUNT        - Optional minimum stake per bet
 * ALLOW_LIST        - `ACTION_INDEX` of a `LIST` of addresses allowed to bet
 * BLOCK_LIST        - `ACTION_INDEX` of a `LIST` of addresses NOT allowed to bet
 * DETAILS           - base64 JSON market definition (validated against OUTCOMES)
 * MEMO              - An optional memo to include
 * FEED_ACTION_INDEX - `ACTION_INDEX` of existing feed
 * OUTCOME           - Outcome index (0-based) bet on / resolved to
 * AMOUNT            - Stake amount (place bet)
 *
 * FORMATS:
 * - 0 = Create Feed
 * - 1 = Cancel Feed
 * - 2 = Place Bet
 * - 3 = Resolve Feed
 *
 ********************************************************************/

// The handler's phases, grouped by concern and installed onto Bet.prototype below
const createFeedPart = require('./create_feed.js');
const validatePart   = require('./validate.js');
const feesPart       = require('./fees.js');
const settlePart     = require('./settle.js');

class Bet {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|LABEL|OUTCOMES|TICK|FEE|DEADLINE|REFUND_WINDOW|MIN_AMOUNT|ALLOW_LIST|BLOCK_LIST|DETAILS|MEMO';
        this.formats[1] = 'VERSION|FEED_ACTION_INDEX|MEMO';
        this.formats[2] = 'VERSION|FEED_ACTION_INDEX|OUTCOME|AMOUNT|MEMO';
        this.formats[3] = 'VERSION|FEED_ACTION_INDEX|OUTCOME|MEMO';

        // Supported list types for ALLOW_LIST/BLOCK_LIST: 2=Address only.
        this.listTypes = [2];
    }

    // Handle parsing the BET transaction
    async parse(params, data, error){
        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string to number so comparisons below are mathematical, not lexical.
        if(!error)
            data = this.util.setNumberFormats(data);

        // Feed, token and balance state every phase below reads
        let { tokenInfo, feedInfo, feedTokenInfo, balances, fees } = await this.loadBetContext(data, format);

        // Canonical outcome labels (trimmed, comma-joined) - computed during
        // validation below and stored on the feed row
        let outcomeLabels = [];

        error = await this.validateCreateFeed(data, format, tokenInfo, outcomeLabels, error);

        error = await this.validateFeedState(data, format, feedInfo, error);

        error = await this.validatePlaceBet(data, format, feedInfo, feedTokenInfo, error);

        error = await this.validatePlaceGating(data, format, feedInfo, error);

        error = await this.validateResolve(data, format, feedInfo, error);

        error = await this.validateFields(data, format, error);

        error = await this.applyFees(data, format, fees, balances, feedTokenInfo, error);

        error = await this.validateFeePayment(data, format, fees, balances, feedTokenInfo, error);

        let status = await this.storeBetRows(data, format, feedInfo, outcomeLabels, error);

        await this.settleBet(data, format, status, feedInfo, feedTokenInfo, fees);
    }

    // The feed row, the wagered token's info and the source's balances and fee object,
    // read once per action in the order the phases below expect them
    async loadBetContext(data, format){

        // Get information on the wagered token (create validates the wager tick;
        // the other formats read it off the feed row below)
        let tokenInfo = false;
        if(format==0 && !this.util.isNull(data['TICK']))
            tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get information on the feed by its action_index (cancel / place / resolve)
        let feedInfo = false;
        if(format==1 || format==2 || format==3)
            feedInfo = await this.indexerDb.getBetFeedInfo(data['FEED_ACTION_INDEX']);

        // The feed's wager token info (place validates AMOUNT at its DECIMALS;
        // settlement floors at its DECIMALS)
        let feedTokenInfo = false;
        if(feedInfo)
            feedTokenInfo = await this.indexerDb.getTokenInfo(feedInfo['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        return { tokenInfo, feedInfo, feedTokenInfo, balances, fees };
    }

    // Canonical stored values, the final status, and the typed row every format writes
    async storeBetRows(data, format, feedInfo, outcomeLabels, error){
        /*****************************************************************
         * Storage + ledger changes
         ****************************************************************/
        // Canonical stored values (create): trimmed labels joined with a single
        // comma, defaulted refund window, materialized expire_at
        if(format==0 && !error)
            data['OUTCOMES'] = outcomeLabels.join(',');

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Clone the raw data for storage
        let bet = Object.assign({}, data);

        // Current lifecycle status for the new row (invalid rows store 'invalid'
        // so they never enter a pool sum or a pass predicate)
        if(format==0)
            bet['FEED_STATUS'] = (status=='valid') ? 'open' : 'invalid';
        if(format==2){
            bet['BET_STATUS'] = (status=='valid') ? 'open' : 'invalid';
            bet['TICK'] = feedInfo ? feedInfo['TICK'] : null; // denormalized feed tick
        }

        // Print status message
        if(format==0)
            getLogger().info("\t BET_FEED : " + this.config['COIN'] + ' : ' + data['LABEL'] + ' : ' + data['STATUS']);
        if(format==1)
            getLogger().info("\t BET_FEED_CANCEL : " + this.config['COIN'] + ':' + data['FEED_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==2)
            getLogger().info("\t BET : " + this.util.logAmount(data['AMOUNT']) + ' ' + (feedInfo ? feedInfo['TICK'] : '?') + ' on ' + data['OUTCOME'] + ' @ ' + this.config['COIN'] + ':' + data['FEED_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==3)
            getLogger().info("\t BET_RESOLVE : " + this.config['COIN'] + ':' + data['FEED_ACTION_INDEX'] + ' -> ' + data['OUTCOME'] + ' : ' + data['STATUS']);

        // Every format stores its own typed row, whatever the status (house
        // convention). The cancel/resolve rows are what make a REJECTED cancel or
        // resolve reportable at all: those legs used to write nothing but a
        // bet_feed_statuses history row, and only on the valid path, so the explorer
        // served the action with a NULL status and the SDK could not tell a rejection
        // from a success (statusKnown:false / statusSource:assumed). These
        // rows carry the PARSE status; the feed's lifecycle status stays in
        // bet_feed_statuses and is still written only by the legs that move it
        if(format==0)
            await this.indexerDb.createBetFeed(bet);
        if(format==1)
            await this.indexerDb.createBetCancel(bet);
        if(format==2)
            await this.indexerDb.createBet(bet);
        if(format==3)
            await this.indexerDb.createBetResolve(bet);

        // Store the SOURCE and wagered TICK in addresses list
        if(format==0)
            this.util.addAddressTicker(data['SOURCE'], data['TICK']);
        if(feedInfo)
            this.util.addAddressTicker(data['SOURCE'], feedInfo['TICK']);

        return status;
    }
}

// Install the phase methods from bet/ NON-ENUMERABLE, the shape the class body they came
// from produced: parse() reaches them as this.<method>, suites can stub them through
// Bet.prototype, and for-in over a handler stays empty. Same install as db/index.js uses
// for its query mixins.
for(const part of [createFeedPart, validatePart, feesPart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Bet.prototype, descriptors);
}

module.exports = Bet;

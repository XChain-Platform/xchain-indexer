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
 * Decentralized parimutuel betting (spec claude/specs/BETTING_SYSTEM_SPEC.md,
 * ). One self-contained action covers the whole market lifecycle: an
 * oracle creates a feed (a betting market defined fully on-chain), anyone
 * bets any live token on an outcome (escrowed at parse), the oracle resolves
 * after the deadline and the protocol pays winners pro-rata from the pot,
 * taking the oracle's percentage fee. Feeds are IMMUTABLE from create; the
 * pre-bet fix path is cancel + recreate. No resolve by expire_at = the
 * system BET_EXPIRE pass refunds every stake (see bet_expire.js and
 * Utility.processBetPasses).
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

        // Define array of supported list types (1=Tick, 2=Address)
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

        // Convert NUMBER fields from string value to number value so comparisons are mathematical
        if(!error)
            data = this.util.setNumberFormats(data);

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

        // Canonical outcome labels (trimmed, comma-joined) - computed during
        // validation below and stored on the feed row
        let outcomeLabels = [];

        /*****************************************************************
         * Format 0 (Create Feed) validations
         ****************************************************************/

        if(format==0){

            // Verify LABEL is present and within length bounds
            if(!error && (this.util.isNull(data['LABEL']) || String(data['LABEL']).length < 1 || String(data['LABEL']).length > this.config['MAX_BET_LABEL_LENGTH']))
                error = 'invalid: LABEL (length)';

            // Verify OUTCOMES: comma-split count bounds
            if(!error){
                let rawOutcomes = this.util.isNull(data['OUTCOMES']) ? [] : String(data['OUTCOMES']).split(',');
                if(rawOutcomes.length < 2 || rawOutcomes.length > this.config['MAX_BET_OUTCOMES'])
                    error = 'invalid: OUTCOMES (count)';
                // Each label trimmed non-empty, within length, and free of the wire
                // delimiters and ASCII control characters (comma cannot survive the
                // split; pipe / semicolon cannot reach us through the wire format;
                // the checks are defense-in-depth per spec)
                if(!error){
                    for(let label of rawOutcomes){
                        let trimmed = String(label).trim();
                        if(trimmed.length < 1 || trimmed.length > this.config['MAX_BET_OUTCOME_LENGTH'] ||
                           /[,|;]/.test(trimmed) || /[\x00-\x1F\x7F]/.test(trimmed)){
                            error = 'invalid: OUTCOMES (label)';
                            break;
                        }
                        outcomeLabels.push(trimmed);
                    }
                }
                // Labels unique by byte-exact comparison after trim (case variants
                // may coexist; wallets warn)
                if(!error && new Set(outcomeLabels).size !== outcomeLabels.length)
                    error = 'invalid: OUTCOMES (duplicate)';
            }

            // Verify TICK: native coin (empty) rejects in v0; token must exist
            if(!error && this.util.isNull(data['TICK']))
                error = 'invalid: TICK (native coin not supported)';
            if(!error && !tokenInfo)
                error = 'invalid: TICK (unknown)';

            // Verify TICK is not sleeping
            if(!error && await this.indexerDb.isActionAllowed(null, data['TICK'], data['BLOCK_INDEX']) == false)
                error = 'invalid: TICK (sleeping)';

            // Controller-bound ticks reject in v0: betting would otherwise bypass the
            // trade controller's listing veto and royalty legs entirely (stake-and-lose
            // to a colluding winner is an uncontrolled transfer). Resolved through the
            // same most-specific-wins map the ORDER guard uses ('trade' falls back to a
            // catch-all 'all' binding), so an all-bound token also rejects.
            if(!error){
                let tickId = await this.indexerDb.getTickerId(data['TICK']);
                let controller = this.util.isNull(tickId) ? null : await this.indexerDb.getEffectiveTokenControllerForGuard(tickId, 'trade', data['BLOCK_INDEX'], data['ACTION_INDEX']);
                if(controller)
                    error = 'invalid: TICK (controller-bound)';
            }

            // Verify FEE: optional percent of the pot, <= 2 decimals, 0..MAX_FEED_FEE
            if(!error && !this.util.isNull(data['FEE'])){
                if(!/^\d+(\.\d{1,2})?$/.test(String(data['FEE'])))
                    error = 'invalid: FEE (format)';
                else if(this.util.bclt(data['FEE'], 0) || this.util.bcgt(data['FEE'], this.config['MAX_FEED_FEE']))
                    error = 'invalid: FEE (range)';
            }

            // Verify DEADLINE: required integer unix time strictly in the future
            if(!error && (this.util.isNull(data['DEADLINE']) || !this.util.isNumeric(data['DEADLINE']) || !this.util.isInteger(data['DEADLINE'])))
                error = 'invalid: DEADLINE (format)';
            if(!error && this.util.bclte(data['DEADLINE'], data['BLOCK_TIME']))
                error = 'invalid: DEADLINE (past)';
            // Horizon cap bounds the expire_at arithmetic and keeps open feeds out of
            // the per-block passes indefinitely
            if(!error && this.util.bcgt(data['DEADLINE'], this.util.bcadd(data['BLOCK_TIME'], this.config['MAX_BET_DEADLINE_HORIZON'], 0)))
                error = 'invalid: DEADLINE (too far)';

            // Verify REFUND_WINDOW: optional (defaulted), integer seconds within bounds
            if(!error && this.util.isNull(data['REFUND_WINDOW']))
                data['REFUND_WINDOW'] = this.config['DEFAULT_BET_REFUND_WINDOW'];
            if(!error && (!this.util.isNumeric(data['REFUND_WINDOW']) || !this.util.isInteger(data['REFUND_WINDOW'])))
                error = 'invalid: REFUND_WINDOW (format)';
            if(!error && (this.util.bclt(data['REFUND_WINDOW'], this.config['MIN_BET_REFUND_WINDOW']) || this.util.bcgt(data['REFUND_WINDOW'], this.config['MAX_BET_REFUND_WINDOW'])))
                error = 'invalid: REFUND_WINDOW (range)';

            // Materialize expire_at at parse (64-bit columns; the horizon + window caps
            // above keep the sum from wrapping)
            if(!error)
                data['EXPIRE_AT'] = this.util.bcadd(data['DEADLINE'], data['REFUND_WINDOW'], 0);

            // Verify MIN_AMOUNT: optional minimum stake at the tick's DECIMALS, > 0
            if(!error && !this.util.isNull(data['MIN_AMOUNT']) && (!this.util.isValidAmountFormat(tokenInfo['DECIMALS'], data['MIN_AMOUNT']) || !this.util.bcgt(data['MIN_AMOUNT'], 0)))
                error = 'invalid: MIN_AMOUNT (format)';

            // Validate LIST fields (ALLOW_LIST / BLOCK_LIST): list exists and is a
            // supported (address) type
            if(!error){
                for(let name of ['ALLOW_LIST', 'BLOCK_LIST']){
                    if(!error && !this.util.isNull(data[name])){
                        let type = await this.indexerDb.getListType(data[name]);
                        if(type===false)
                            error = 'invalid: ' + name + ' (unknown)';
                        else if(!this.listTypes.includes(type))
                            error = 'invalid: ' + name + ' (unsupported)';
                    }
                }
            }

            // When both gating lists are set they must differ: the same list in both
            // slots builds a feed nobody can ever bet on, which looks live in the
            // explorer and only burns pass rows until it expires
            if(!error && !this.util.isNull(data['ALLOW_LIST']) && !this.util.isNull(data['BLOCK_LIST']) && Number(data['ALLOW_LIST'])===Number(data['BLOCK_LIST']))
                error = 'invalid: BLOCK_LIST (same as ALLOW_LIST)';

            // Validate DETAILS (optional): strict base64 wrapping a JSON object whose
            // optional `outcomes` array must agree with the consensus OUTCOMES field
            if(!error && !this.util.isNull(data['DETAILS']))
                error = this._validateDetails(String(data['DETAILS']), outcomeLabels);
        }

        /*****************************************************************
         * Format 1 / 2 / 3 (existing feed) validations
         ****************************************************************/

        // Validate FEED_ACTION_INDEX references a known feed
        if(!error && (format==1 || format==2 || format==3) && !feedInfo)
            error = 'invalid: FEED_ACTION_INDEX (unknown)';

        // Owner-only formats (cancel / resolve)
        if(!error && (format==1 || format==3) && data['SOURCE']!=feedInfo['SOURCE'])
            error = 'invalid: SOURCE (not owner)';

        // Cancel / resolve require a live (open or closed) feed. Cancel deliberately
        // has NO expire_at clock bound: it stays valid on a feed a deferred expiry
        // pass has not reached yet (cancel and expiry are refund-identical; only the
        // terminal status differs). Do NOT "fix" this with a clock check.
        if(!error && (format==1 || format==3) && !['open','closed'].includes(feedInfo['FEED_STATUS']))
            error = 'invalid: FEED_ACTION_INDEX (feed not open)';

        if(format==2){
            // Place requires the stored latch to still read open AND the direct clock
            // check. Both are required: the latch closes the backdating hole once any
            // block has crossed DEADLINE (chain timestamps are not monotonic); the
            // direct check covers the first crossing block itself, since the latch is
            // written by the end-of-block pass
            if(!error && feedInfo['FEED_STATUS']!='open')
                error = 'invalid: FEED_ACTION_INDEX (feed not open)';
            if(!error && !this.util.bclt(data['BLOCK_TIME'], feedInfo['DEADLINE']))
                error = 'invalid: FEED_ACTION_INDEX (closed)';

            // The oracle may not bet its own feed: it decides whether the feed resolves
            // at all, and expiry refunds every stake in full, so a betting oracle holds
            // a free option to un-bet by walking away (spec trust model)
            if(!error && data['SOURCE']==feedInfo['SOURCE'])
                error = 'invalid: SOURCE (oracle may not bet own feed)';

            // OUTCOME must be an integer inside the feed's outcome range
            let outcomeCount = feedInfo ? String(feedInfo['OUTCOMES']).split(',').length : 0;
            if(!error && (this.util.isNull(data['OUTCOME']) || !this.util.isNumeric(data['OUTCOME']) || !this.util.isInteger(data['OUTCOME']) || Number(data['OUTCOME']) < 0 || Number(data['OUTCOME']) >= outcomeCount))
                error = 'invalid: OUTCOME (range)';

            // AMOUNT at the feed tick's DECIMALS, strictly positive
            if(!error && (this.util.isNull(data['AMOUNT']) || !this.util.isValidAmountFormat(feedTokenInfo['DECIMALS'], data['AMOUNT'])))
                error = 'invalid: AMOUNT (format)';
            if(!error && !this.util.bcgt(data['AMOUNT'], 0))
                error = 'invalid: AMOUNT (must be positive)';
            if(!error && !this.util.isNull(feedInfo['MIN_AMOUNT']) && this.util.bclt(data['AMOUNT'], feedInfo['MIN_AMOUNT']))
                error = 'invalid: AMOUNT (below feed minimum)';

            // Bound single-block settlement work: the feed must not be full
            if(!error && await this.indexerDb.countOpenBetsByFeed(feedInfo['ACTION_INDEX']) >= this.config['MAX_BETS_PER_FEED'])
                error = 'invalid: FEED_ACTION_INDEX (feed full)';

            // Feed gating, evaluated against the LISTs' state at THIS block (later
            // list changes never affect already-placed bets). Checks run allow-then-
            // block and BLOCK_LIST WINS: an address on both lists is rejected
            if(!error && !this.util.isNull(feedInfo['ALLOW_LIST'])){
                let allowList = await this.indexerDb.getList(feedInfo['ALLOW_LIST']);
                if(!allowList.includes(data['SOURCE']))
                    error = 'invalid: SOURCE (not authorized)';
            }
            if(!error && !this.util.isNull(feedInfo['BLOCK_LIST'])){
                let blockList = await this.indexerDb.getList(feedInfo['BLOCK_LIST']);
                if(blockList.includes(data['SOURCE']))
                    error = 'invalid: SOURCE (not authorized)';
            }

            // Verify the feed tick is not sleeping and SOURCE may act on it (house
            // token allow/block lists); place-time checks gate entry, terminal-path
            // credits are unconditional (nothing may wedge exit)
            if(!error && await this.indexerDb.isActionAllowed(null, feedInfo['TICK'], data['BLOCK_INDEX']) == false)
                error = 'invalid: TICK (sleeping)';
            if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], feedInfo['TICK']) == false)
                error = 'invalid: SOURCE (not authorized)';
        }

        if(format==3){
            // No early resolution: DEADLINE is both betting close and earliest resolve.
            // An oracle may resolve in the first deadline-crossing block, before the
            // end-of-block pass latches (status is still open there)
            if(!error && this.util.bclt(data['BLOCK_TIME'], feedInfo['DEADLINE']))
                error = 'invalid: FEED_ACTION_INDEX (not closed)';
            // A resolve at/after expire_at is invalid; the pass in that same block
            // expires the feed (deterministic resolve-vs-expire boundary)
            if(!error && !this.util.bclt(data['BLOCK_TIME'], feedInfo['EXPIRE_AT']))
                error = 'invalid: FEED_ACTION_INDEX (refund window expired)';
            // OUTCOME must be an integer inside the feed's outcome range
            let outcomeCount = feedInfo ? String(feedInfo['OUTCOMES']).split(',').length : 0;
            if(!error && (this.util.isNull(data['OUTCOME']) || !this.util.isNumeric(data['OUTCOME']) || !this.util.isInteger(data['OUTCOME']) || Number(data['OUTCOME']) < 0 || Number(data['OUTCOME']) >= outcomeCount))
                error = 'invalid: OUTCOME (range)';
        }

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify SOURCE may act on the wagered tick (house token allow/block lists, create only;
        // place checks the feed tick above)
        if(!error && format==0 && await this.indexerDb.isActionAllowed(data['SOURCE'], data['TICK']) == false)
            error = 'invalid: SOURCE (not authorized)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        /*****************************************************************
         * Fees (unified schedule only: BET and UNIFIED_FEES are both
         * genesis-active on every chain and network, so a BET action can
         * never process below the gate; the legacy else-branch order.js
         * carries would be dead code here, and dead code that silently
         * charges zero if the condition were ever mis-evaluated)
         ****************************************************************/

        fees['AMOUNT'] = 0;

        // Create: duration-metered on the feed's full pass-eligible life
        // (expire_at - BLOCK_TIME), the ORDER/DISPENSER expiration mechanism
        // with its own schedule key (spec decision F). Short feeds inside the
        // shared free window create for nothing
        if(!error && format==0){
            let duration = this.util.getUnifiedDurationFee(data['EXPIRE_AT'], data['BLOCK_TIME'], 'BET_FEED_PER_DAY');
            fees['GAS_COST']    = duration.gasCost;
            fees['AMOUNT']      = duration.fee;
            fees['FEE_VERSION'] = 2;
        }

        // Place: one terminal credit pre-funded (AIRDROP per-recipient parity).
        // This is what makes the free system-injected expiry pass sound: every
        // refund credit BET_EXPIRE emits was paid for here
        if(!error && format==2){
            let credit = this.util.getUnifiedTransactionFee(1, 'BET_PER_CREDIT');
            fees['GAS_COST']    = credit.gasCost;
            fees['AMOUNT']      = credit.fee;
            fees['FEE_VERSION'] = 2;
        }

        // Cancel and resolve are FREE (decision F): every credit they emit is
        // pre-funded at place time, and a resolve surcharge would be griefable
        // (dust bets inflating the oracle's cost until rational expiry)

        // Validate fee payment (native coin or XCHAIN balance)
        if(!error && this.util.bcgt(fees['AMOUNT'], 0)){
            let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(paymentMode === 'native'){
                let validation = await this.util.validateNativeCoinFee(data, fees, this.indexerDb, data['TX_OUTPUTS']);
                if(!validation.valid){
                    error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                } else {
                    fees['PAYMENT_MODE']       = 1;
                    fees['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                    fees['NATIVE_COIN']        = validation.nativeCoin;
                    fees['ORACLE_ROUND']       = validation.oracleRound;
                }
            } else if(paymentMode === 'rejected'){
                error = 'invalid: insufficient fee (native coin output required)';
            } else {
                if(!this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                    error = 'invalid: insufficient funds (FEE)';
            }
        }

        // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // Verify SOURCE has enough balance to cover the stake (place, after fee deduction)
        if(!error && format==2 && !this.util.hasBalance(balances, feedTokenInfo['TICK_ID'], data['AMOUNT']))
            error = 'invalid: insufficient funds (AMOUNT)';

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
            console.log("\t BET_FEED : " + this.config['COIN'] + ' : ' + data['LABEL'] + ' : ' + data['STATUS']);
        if(format==1)
            console.log("\t BET_FEED_CANCEL : " + this.config['COIN'] + ':' + data['FEED_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==2)
            console.log("\t BET : " + data['AMOUNT'] + ' ' + (feedInfo ? feedInfo['TICK'] : '?') + ' on ' + data['OUTCOME'] + ' @ ' + this.config['COIN'] + ':' + data['FEED_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==3)
            console.log("\t BET_RESOLVE : " + this.config['COIN'] + ':' + data['FEED_ACTION_INDEX'] + ' -> ' + data['OUTCOME'] + ' : ' + data['STATUS']);

        // Create record in bet_feeds / bets tables (create and place store a row
        // whatever the status, house convention; cancel and resolve live in the
        // actions table + status history rows only)
        if(format==0)
            await this.indexerDb.createBetFeed(bet);
        if(format==2)
            await this.indexerDb.createBet(bet);

        // Store the SOURCE and wagered TICK in addresses list
        if(format==0)
            this.util.addAddressTicker(data['SOURCE'], data['TICK']);
        if(feedInfo)
            this.util.addAddressTicker(data['SOURCE'], feedInfo['TICK']);

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // If this was a valid transaction, process the lifecycle leg
        if(status=='valid'){

            // If we are charging a fee, store the SOURCE and fees TICK in addresses list
            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Format 0 - Create Feed: open-status history row (caused by the create)
            if(format==0)
                await this.indexerDb.createBetFeedStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');

            // Format 2 - Place Bet: escrow the stake at parse (ORDER GIVE pattern);
            // bets are FINAL (no cancel path)
            if(format==2){
                debits.push([feedInfo['TICK'], data['AMOUNT'], data['SOURCE']]);
                escrows.push([feedInfo['TICK'], data['AMOUNT'], data['SOURCE']]);
                await this.indexerDb.createBetStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');
            }

            // Format 1 - Cancel Feed: refund every open stake in full, no oracle fee.
            // The oracle's honest out for postponed/voided events
            if(format==1)
                await this._refundOpenBets(data, feedInfo, 'cancelled', credits, escrows);

            // Format 3 - Resolve Feed: settle inline (DISPENSE precedent)
            if(format==3)
                await this._settleFeed(data, feedInfo, feedTokenInfo, credits, escrows);

            // Handle any transaction FEE according to the user's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Process any transaction ledger changes (credits / debits / escrows)
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

            // Get a list of tickers & addresses
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            // Update address balances and token supply
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);
        }

        // Create action mappings
        await this.mapper.createMappings(data);
    }

    /*****************************************************************
     * Terminal paths (shared by cancel here and BET_EXPIRE's sibling)
     ****************************************************************/

    // Refund every `open` bet on the feed in full (the normative bet_status='open'
    // predicate: rows already refunded/settled by another path are never selected,
    // so no path can double-pay) and move the feed to `terminalStatus`. Terminal
    // credits are protocol credits that BYPASS sleeping and token-list checks:
    // place-time checks gate entry, nothing may wedge exit, or escrow strands and
    // conservation breaks.
    async _refundOpenBets(data, feedInfo, terminalStatus, credits, escrows){
        let openBets = await this.indexerDb.getOpenBetsByFeed(feedInfo['ACTION_INDEX']);
        for(let betRow of openBets){
            // Release escrow and credit the stake back to the ORIGINAL bettor
            // (BigNumber-space negation, not JS unary minus)
            escrows.push([feedInfo['TICK'], this.util.bcsub(0, betRow['AMOUNT'], 64), betRow['SOURCE']]);
            credits.push([feedInfo['TICK'], betRow['AMOUNT'], betRow['SOURCE']]);
            this.util.addAddressTicker(betRow['SOURCE'], feedInfo['TICK']);
            // One terminal flip per bet: current-status column + stamp + history row
            await this.indexerDb.setBetSettled(betRow['ACTION_INDEX'], 'refunded', data['BLOCK_INDEX']);
            await this.indexerDb.createBetStatus(data['ACTION_INDEX'], betRow['ACTION_INDEX'], 'refunded');
        }
        // Feed terminal flip: current-status column + terminal_block stamp + history row
        await this.indexerDb.setBetFeedTerminal(feedInfo['ACTION_INDEX'], terminalStatus, data['BLOCK_INDEX']);
        await this.indexerDb.createBetFeedStatus(data['ACTION_INDEX'], feedInfo['ACTION_INDEX'], terminalStatus);
        this.util.addAddressTicker(feedInfo['SOURCE'], feedInfo['TICK']);
    }

    // Parimutuel settlement (spec section 7, consensus-critical). All arithmetic in
    // mathjs bignumber via the house bc* helpers; every division/floor at the feed
    // tick's DECIMALS. The pool predicate is normative: only bet_status='open' rows
    // are summed, and every summed row leaves 'open' in this same action.
    async _settleFeed(data, feedInfo, feedTokenInfo, credits, escrows){
        let d       = feedTokenInfo['DECIMALS'];
        let winning = Number(data['OUTCOME']);
        let count   = String(feedInfo['OUTCOMES']).split(',').length;

        let openBets = await this.indexerDb.getOpenBetsByFeed(feedInfo['ACTION_INDEX']);

        // Outcome-range assertion (normative): a summed bet outside 0..count-1 is a
        // consensus-fatal indexer error. HALT - never skip, never treat the pool as
        // empty: the silent failure mode is a real winner flipping to resolved_void
        // with everyone refunded and no error anywhere.
        for(let betRow of openBets){
            let o = Number(betRow['OUTCOME']);
            if(!Number.isInteger(o) || o < 0 || o >= count)
                throw new Error('BET settlement: bet ' + betRow['ACTION_INDEX'] + ' outcome ' + betRow['OUTCOME'] + ' outside 0..' + (count-1) + ' of feed ' + feedInfo['ACTION_INDEX'] + ' - consensus-fatal, halting');
        }

        // Pool totals from the open rows (T = all outcomes, W = winning outcome)
        let T = 0, W = 0;
        for(let betRow of openBets){
            T = this.util.bcadd(T, betRow['AMOUNT'], d);
            if(Number(betRow['OUTCOME']) === winning)
                W = this.util.bcadd(W, betRow['AMOUNT'], d);
        }

        if(this.util.bcgt(W, 0)){
            // Normal settlement: oracle fee off the top (FEE is a percent, so /100),
            // winners split the pot pro-rata, floored at the tick's decimals; the
            // rounding remainder (dust) rides the oracle credit
            let feeFraction = this.util.bcdiv(feedInfo['FEE'], 100, 4);   // <=2dp percent -> exact 4dp fraction
            let fee  = this.util.bcmulfloor(T, feeFraction, d);
            let pot  = this.util.bcsub(T, fee, d);
            let paid = 0;
            for(let betRow of openBets){
                // Every open bet leaves escrow here, winner or loser: winners' payouts
                // include their stake share by construction, losers' stakes are
                // consumed by the pot
                escrows.push([feedInfo['TICK'], this.util.bcsub(0, betRow['AMOUNT'], 64), betRow['SOURCE']]);
                this.util.addAddressTicker(betRow['SOURCE'], feedInfo['TICK']);
                if(Number(betRow['OUTCOME']) === winning){
                    let payout = this.util.bcmuldivfloor(betRow['AMOUNT'], pot, W, d);
                    // Zero-floor rule: a payout flooring to exactly zero emits NO
                    // credit row; the amount is absorbed into dust. The bet still
                    // transitions to won (at most one terminal credit per bet)
                    if(this.util.bcgt(payout, 0)){
                        credits.push([feedInfo['TICK'], payout, betRow['SOURCE']]);
                        paid = this.util.bcadd(paid, payout, d);
                    }
                    await this.indexerDb.setBetSettled(betRow['ACTION_INDEX'], 'won', data['BLOCK_INDEX']);
                    await this.indexerDb.createBetStatus(data['ACTION_INDEX'], betRow['ACTION_INDEX'], 'won');
                } else {
                    await this.indexerDb.setBetSettled(betRow['ACTION_INDEX'], 'lost', data['BLOCK_INDEX']);
                    await this.indexerDb.createBetStatus(data['ACTION_INDEX'], betRow['ACTION_INDEX'], 'lost');
                }
            }
            // Oracle credit: fee plus rounding dust, one credit (absorbed by the
            // flat-free resolve; never charged per-credit). Skipped when zero so a
            // zero-fee dust-free market emits no empty ledger row
            let oracleCredit = this.util.bcadd(fee, this.util.bcsub(pot, paid, d), d);
            if(this.util.bcgt(oracleCredit, 0))
                credits.push([feedInfo['TICK'], oracleCredit, feedInfo['SOURCE']]);
            await this.indexerDb.setBetFeedTerminal(feedInfo['ACTION_INDEX'], 'resolved', data['BLOCK_INDEX']);
            await this.indexerDb.createBetFeedStatus(data['ACTION_INDEX'], feedInfo['ACTION_INDEX'], 'resolved');
            this.util.addAddressTicker(feedInfo['SOURCE'], feedInfo['TICK']);
        } else {
            // Empty winning pool (decision E): full refund, NO oracle fee. Bettors
            // never net-lose to an outcome nobody backed
            await this._refundOpenBets(data, feedInfo, 'resolved_void', credits, escrows);
        }
    }

    /*****************************************************************
     * DETAILS validation
     ****************************************************************/

    // Validate the base64 JSON market definition. Returns an error string or null.
    _validateDetails(details, outcomeLabels){
        // Strict base64: charset with = padding, length % 4 == 0, and a re-encode
        // that round-trips byte-identically (rejects non-canonical encodings)
        if(!/^[A-Za-z0-9+/]+={0,2}$/.test(details) || details.length % 4 !== 0)
            return 'invalid: DETAILS (format)';
        let decoded = Buffer.from(details, 'base64');
        if(decoded.toString('base64') !== details)
            return 'invalid: DETAILS (format)';
        if(decoded.length > this.config['MAX_BET_DETAILS_LENGTH'])
            return 'invalid: DETAILS (length)';
        let parsed = null;
        try {
            parsed = JSON.parse(decoded.toString('utf8'));
        } catch(e){
            return 'invalid: DETAILS (json)';
        }
        // Top-level object (not array/scalar) with bounded nesting depth: the depth
        // cap bounds the recursion the SDK schema check and the explorer renderer
        // perform on attacker-chosen input (total walk work is already bounded by
        // MAX_BET_DETAILS_LENGTH)
        if(parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return 'invalid: DETAILS (json shape)';
        if(this._jsonDepth(parsed) > this.config['MAX_BET_DETAILS_DEPTH'])
            return 'invalid: DETAILS (json shape)';
        // An `outcomes` key must be an array whose labels equal the canonical
        // OUTCOMES exactly (order + count + byte-equal after trim); present-but-
        // not-array is also a mismatch
        if(Object.prototype.hasOwnProperty.call(parsed, 'outcomes')){
            let list = parsed['outcomes'];
            if(!Array.isArray(list) || list.length !== outcomeLabels.length)
                return 'invalid: DETAILS (outcomes mismatch)';
            for(let i = 0; i < list.length; i++){
                if(String(list[i]).trim() !== outcomeLabels[i])
                    return 'invalid: DETAILS (outcomes mismatch)';
            }
        }
        return null;
    }

    // Nesting depth of a parsed JSON value (objects and arrays count one level each)
    _jsonDepth(node, depth = 1){
        if(node === null || typeof node !== 'object')
            return depth;
        let max = depth;
        // Early exit once past the cap: bounded work on adversarial input
        for(let key of Object.keys(node)){
            let child = this._jsonDepth(node[key], depth + 1);
            if(child > max) max = child;
            if(max > this.config['MAX_BET_DETAILS_DEPTH']) return max;
        }
        return max;
    }
}

module.exports = Bet;

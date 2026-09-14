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
 * BET settlement: the lifecycle leg a VALID action runs, the terminal refund that
 * cancel shares with BET_EXPIRE, and parimutuel resolution of a feed's pot.
 * Every amount goes through the house bc* helpers at the feed tick's DECIMALS.
 *
 ********************************************************************/

// Installed onto Bet.prototype by bet.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Lifecycle leg of a VALID bet: escrow or settle, then fees and balances
    async settleBet(data, format, status, feedInfo, feedTokenInfo, fees){

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
                await this.refundOpenBets(data, feedInfo, 'cancelled', credits, escrows);

            // Format 3 - Resolve Feed: settle inline (DISPENSE precedent)
            if(format==3)
                await this.settleFeed(data, feedInfo, feedTokenInfo, credits, escrows);

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
    },

    // Terminal paths (shared by cancel here and BET_EXPIRE's sibling)

    // Refund every `open` bet on the feed in full (the normative bet_status='open'
    // predicate: rows already refunded/settled by another path are never selected,
    // so no path can double-pay) and move the feed to `terminalStatus`. Terminal
    // credits are protocol credits that BYPASS sleeping and token-list checks:
    // place-time checks gate entry, nothing may wedge exit, or escrow strands and
    // conservation breaks.
    async refundOpenBets(data, feedInfo, terminalStatus, credits, escrows){
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
    },

    // Parimutuel settlement (consensus-critical). All arithmetic in
    // mathjs bignumber via the house bc* helpers; every division/floor at the feed
    // tick's DECIMALS. The pool predicate is normative: only bet_status='open' rows
    // are summed, and every summed row leaves 'open' in this same action.
    async settleFeed(data, feedInfo, feedTokenInfo, credits, escrows){
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
            await this.settleWinningPool(data, feedInfo, d, winning, openBets, T, W, credits, escrows);
        } else {
            // Empty winning pool (decision E): full refund, NO oracle fee. Bettors
            // never net-lose to an outcome nobody backed
            await this.refundOpenBets(data, feedInfo, 'resolved_void', credits, escrows);
        }
    },

    // Pay a resolved feed's winners pro-rata and credit the oracle its fee plus dust.
    // Every amount is mathjs bignumber through the house bc* helpers, floored at the
    // feed tick's DECIMALS.
    async settleWinningPool(data, feedInfo, d, winning, openBets, T, W, credits, escrows){
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
    }
};

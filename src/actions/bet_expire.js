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
 * XChain Platform Action - BET_EXPIRE
 *
 * System-injected when a feed reaches expire_at (deadline + refund_window)
 * without a resolve: every `open` bet is refunded in full, NO oracle fee,
 * the feed goes `expired`. Injected by the bounded end-of-block pass
 * (Utility.processBetPasses), never wallet-broadcast. The refund credits
 * are pre-funded by the bettors' place-time BET_PER_CREDIT gas, which is
 * what makes this pass free to run.
 *
 ********************************************************************/

class Bet_Expire {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
    }

    // data['ACTION_INDEX'] arrives as the FEED's action_index (the processExpirations
    // injection shape); a fresh action row is minted below for the expire record itself.
    async parse(params, data, error){
        let feedInfo = await this.indexerDb.getBetFeedInfo(data['ACTION_INDEX']);

        // Bail out if the feed no longer exists or already left the live statuses
        // (already expired / resolved / cancelled, or rolled back). This is the
        // idempotence guard for a crash-restart replay of the pass: re-processing
        // a block must not refund twice (the bet_status='open' predicate below is
        // the second, per-bet layer of the same guarantee)
        if(!feedInfo || !['open','closed'].includes(feedInfo['FEED_STATUS']))
            return;

        this.util.addAddressTicker(feedInfo['SOURCE'], feedInfo['TICK']);

        // Mint a fresh action row for the expire record itself (ORDER_EXPIRE precedent):
        // the injected data carried the feed's index, not a new one of its own.
        let action = {};
        action['ACTION']      = 'BET_EXPIRE';
        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];
        data['ACTION_INDEX']  = await this.indexerDb.createActionIndex(action);

        data['STATUS'] = 'valid';

        console.log("\t BET_EXPIRE : " + this.config['COIN'] + ':' + feedInfo['ACTION_INDEX'] + ' : ' + data['STATUS']);

        let credits = [],
            debits  = [],
            escrows = [];

        // Refund every open bet in full (the normative bet_status='open' predicate;
        // rows another terminal path already moved are never selected). Terminal
        // credits are unconditional: they bypass sleeping and token-list checks,
        // nothing may wedge exit or escrow strands
        let openBets = await this.indexerDb.getOpenBetsByFeed(feedInfo['ACTION_INDEX']);
        for(let betRow of openBets){
            // Release escrow and credit the stake back to the ORIGINAL bettor
            // (BigNumber-space negation, not JS unary minus)
            escrows.push([feedInfo['TICK'], this.util.bcsub(0, betRow['AMOUNT'], 64), betRow['SOURCE']]);
            credits.push([feedInfo['TICK'], betRow['AMOUNT'], betRow['SOURCE']]);
            this.util.addAddressTicker(betRow['SOURCE'], feedInfo['TICK']);
            await this.indexerDb.setBetSettled(betRow['ACTION_INDEX'], 'refunded', data['BLOCK_INDEX']);
            await this.indexerDb.createBetStatus(data['ACTION_INDEX'], betRow['ACTION_INDEX'], 'refunded');
        }

        // Feed terminal flip: current-status column + terminal_block stamp + history
        // row (caused by this BET_EXPIRE's minted action row)
        await this.indexerDb.setBetFeedTerminal(feedInfo['ACTION_INDEX'], 'expired', data['BLOCK_INDEX']);
        await this.indexerDb.createBetFeedStatus(data['ACTION_INDEX'], feedInfo['ACTION_INDEX'], 'expired');

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Bet_Expire;

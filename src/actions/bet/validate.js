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
 * BET checks on an existing feed and on every action: whether the feed can take
 * this cancel, bet or resolve, who may place on it, and the SOURCE and MEMO rules
 * all four formats share.
 *
 ********************************************************************/

// Installed onto Bet.prototype by bet.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Format 1 / 2 / 3 (existing feed) validations
    async validateFeedState(data, format, feedInfo, error){
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

        return error;
    },

    // Format 2 (Place Bet) validations
    async validatePlaceBet(data, format, feedInfo, feedTokenInfo, error){
        if(format==2){
            // Place requires the stored latch to still read open AND the direct clock
            // check. Both are required: the latch closes the backdating hole once any
            // block has crossed DEADLINE (chain timestamps are not monotonic); the
            // direct check covers the first crossing block itself, since the latch is
            // written by the end-of-block pass
            if(!error && feedInfo['FEED_STATUS']!='open')
                error = 'invalid: FEED_ACTION_INDEX (feed not open)';
            // Betting closes AT the deadline, so a bet in the deadline block itself is late.
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
            if(!error && (this.util.isNull(data['AMOUNT']) || !this.util.isValidAmountFormat(feedTokenInfo['DECIMALS'], data['AMOUNT'], data['BLOCK_TIME'])))
                error = 'invalid: AMOUNT (format)';
            if(!error && !this.util.bcgt(data['AMOUNT'], 0))
                error = 'invalid: AMOUNT (must be positive)';
            // Verify AMOUNT meets the feed's minimum stake, when the oracle set one
            if(!error && !this.util.isNull(feedInfo['MIN_AMOUNT']) && this.util.bclt(data['AMOUNT'], feedInfo['MIN_AMOUNT']))
                error = 'invalid: AMOUNT (below feed minimum)';

            // Bound single-block settlement work: the feed must not be full
            if(!error && await this.indexerDb.countOpenBetsByFeed(feedInfo['ACTION_INDEX']) >= this.config['MAX_BETS_PER_FEED'])
                error = 'invalid: FEED_ACTION_INDEX (feed full)';

        }

        return error;
    },

    // Who may place on this feed: the feed's gating lists, and the tick's own sleep
    // and allow/block state at this block
    async validatePlaceGating(data, format, feedInfo, error){
        if(format==2){
            // Feed gating, evaluated against the LISTs' state at THIS block (later
            // list changes never affect already-placed bets). Checks run allow-then-
            // block and BLOCK_LIST WINS: an address on both lists is rejected
            if(!error && !this.util.isNull(feedInfo['ALLOW_LIST'])){
                let allowList = await this.indexerDb.getList(feedInfo['ALLOW_LIST'], data['BLOCK_INDEX']);
                if(!allowList.includes(data['SOURCE']))
                    error = 'invalid: SOURCE (not authorized)';
            }
            if(!error && !this.util.isNull(feedInfo['BLOCK_LIST'])){
                let blockList = await this.indexerDb.getList(feedInfo['BLOCK_LIST'], data['BLOCK_INDEX']);
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

        return error;
    },

    // Format 3 (Resolve Feed) validations
    async validateResolve(data, format, feedInfo, error){
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
            let outcomeCount = feedInfo ? String(feedInfo['OUTCOMES']).split(',').length : 0;
            // Verify OUTCOME is an integer inside the feed's outcome range
            if(!error && (this.util.isNull(data['OUTCOME']) || !this.util.isNumeric(data['OUTCOME']) || !this.util.isInteger(data['OUTCOME']) || Number(data['OUTCOME']) < 0 || Number(data['OUTCOME']) >= outcomeCount))
                error = 'invalid: OUTCOME (range)';
        }

        return error;
    },

    /*****************************************************************
     * General Validations
     ****************************************************************/
    async validateFields(data, format, error){

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify SOURCE may act on the wagered tick (house token allow/block lists, create
        // only; place checks the feed tick above)
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

        return error;
    }
};

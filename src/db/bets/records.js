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
 * XChain Indexer - Database mixin part: bets / records
 *
 * The create-or-update writers for bet_feeds, bets, bet_cancels, bet_resolves and the
 * two status-history tables (bet_feed_statuses, bet_statuses).
 * Merged into the bets mixin by db/bets.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `bet_feeds` table
    async createBetFeed(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let feed_status_id = await this.createStatus(data['FEED_STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let label          = data['LABEL'];
        let outcomes       = data['OUTCOMES'];
        let fee            = data['FEE'];
        let deadline       = data['DEADLINE'];
        let refund_window  = data['REFUND_WINDOW'];
        let expire_at      = data['EXPIRE_AT'];
        let min_amount     = data['MIN_AMOUNT'];
        let allow_list     = data['ALLOW_LIST'];
        let block_list     = data['BLOCK_LIST'];
        let details        = data['DETAILS'];
        // Check if record already exists for this feed
        let query  = `SELECT
                            action_index
                        FROM
                            bet_feeds
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record (the latch/terminal stamps are OWNED by
            // latchBetFeedClosed / setBetFeedTerminal and never touched here)
            query = `UPDATE
                        bet_feeds
                    SET
                        label=?,
                        outcomes=?,
                        tick_id=?,
                        fee=?,
                        deadline=?,
                        refund_window=?,
                        expire_at=?,
                        min_amount=?,
                        allow_list=?,
                        block_list=?,
                        details=?,
                        memo_id=?,
                        status_id=?,
                        feed_status_id=?
                    WHERE
                        action_index=?`;
            args = [label, outcomes, tick_id, fee, deadline, refund_window, expire_at, min_amount, allow_list, block_list, details, memo_id, status_id, feed_status_id, action_index];
        } else {
            // INSERT record (stamps start NULL: not latched, not terminal)
            query = `INSERT INTO bet_feeds (label, outcomes, tick_id, fee, deadline, refund_window, expire_at, min_amount, allow_list, block_list, details, memo_id, status_id, feed_status_id, closed_block, terminal_block, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`;
            args = [label, outcomes, tick_id, fee, deadline, refund_window, expire_at, min_amount, allow_list, block_list, details, memo_id, status_id, feed_status_id, action_index];
        }
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `bets` table
    async createBet(data){
        data              = this.normalizeDataValues(data);
        let tick_id       = await this.createTicker(data['TICK']);
        let memo_id       = await this.createMemo(data['MEMO']);
        let status_id     = await this.createStatus(data['STATUS']);
        let bet_status_id = await this.createStatus(data['BET_STATUS']);
        let action_index  = data['ACTION_INDEX'];
        let feed_index    = data['FEED_ACTION_INDEX'];
        let outcome       = data['OUTCOME'];
        let amount        = data['AMOUNT'];
        // Check if record already exists for this bet
        let query  = `SELECT
                            action_index
                        FROM
                            bets
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record (settled_block is OWNED by setBetSettled)
            query = `UPDATE
                        bets
                    SET
                        feed_action_index=?,
                        outcome=?,
                        tick_id=?,
                        amount=?,
                        memo_id=?,
                        status_id=?,
                        bet_status_id=?
                    WHERE
                        action_index=?`;
            args = [feed_index, outcome, tick_id, amount, memo_id, status_id, bet_status_id, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO bets (feed_action_index, outcome, tick_id, amount, memo_id, status_id, bet_status_id, settled_block, action_index) values (?, ?, ?, ?, ?, ?, ?, NULL, ?)`;
            args = [feed_index, outcome, tick_id, amount, memo_id, status_id, bet_status_id, action_index];
        }
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `bet_cancels` table (BET format 1). Written for every
    // cancel action whatever its parse status - that is the table's reason to exist:
    // a rejected cancel writes nothing at all otherwise, so no API consumer
    // could distinguish it from a successful one. `status_id` is the PARSE status;
    // the feed's lifecycle status lives in bet_feed_statuses / bet_feeds
    async createBetCancel(data){
        data                  = this.normalizeDataValues(data);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let feed_action_index = data['FEED_ACTION_INDEX'];
        // Check if record already exists for this cancel
        let query  = `SELECT
                            action_index
                        FROM
                            bet_cancels
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        bet_cancels
                    SET
                        feed_action_index=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO bet_cancels (feed_action_index, memo_id, status_id, action_index) values (?, ?, ?, ?)`;
        }
        args    = [feed_action_index, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `bet_resolves` table (BET format 3). Same discipline as
    // createBetCancel: stored whatever the parse status. `outcome` is the outcome the
    // oracle CLAIMED, so on an invalid row it settles nothing and is audit data only
    async createBetResolve(data){
        data                  = this.normalizeDataValues(data);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let feed_action_index = data['FEED_ACTION_INDEX'];
        let outcome           = data['OUTCOME'];
        // Check if record already exists for this resolve
        let query  = `SELECT
                            action_index
                        FROM
                            bet_resolves
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        bet_resolves
                    SET
                        feed_action_index=?,
                        outcome=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO bet_resolves (feed_action_index, outcome, memo_id, status_id, action_index) values (?, ?, ?, ?, ?)`;
        }
        args    = [feed_action_index, outcome, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `bet_feed_statuses` table (status history; the
    // causing action's index + the feed's index, order_statuses pattern). The
    // `closed` latch writes NO row here - it has no causing action; its durable
    // record is bet_feeds.closed_block
    async createBetFeedStatus(action_index, feed_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists in bet_feed_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            bet_feed_statuses
                        WHERE
                            action_index=? AND
                            feed_action_index=?`;
        let args = [action_index, feed_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        bet_feed_statuses
                    SET
                        status_id=?
                    WHERE
                        action_index=? AND
                        feed_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO bet_feed_statuses (status_id, action_index, feed_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, feed_action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `bet_statuses` table (status history per bet)
    async createBetStatus(action_index, bet_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists in bet_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            bet_statuses
                        WHERE
                            action_index=? AND
                            bet_action_index=?`;
        let args = [action_index, bet_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        bet_statuses
                    SET
                        status_id=?
                    WHERE
                        action_index=? AND
                        bet_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO bet_statuses (status_id, action_index, bet_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, bet_action_index];
        results = await this.doQuery(query, args);
    },

};

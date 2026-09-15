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
 * XChain Indexer - Database mixin part: orders (order rows)
 *
 * The writes to orders and to the per-order statuses, expiries, edits and cancels.
 * A part of the orders mixin: src/db/orders/index.js merges it into the one method set that
 * db/index.js installs onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// The UPDATE half of createOrder's upsert. Its column list alone would carry the method
// past the function limit, so the statement lives here, its text unchanged.
const ORDER_UPDATE_SQL = `UPDATE
                        orders
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_ownership=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_ownership=?,
                        get_address_id=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        payout_legs=?
                    WHERE
                        action_index=?`;

module.exports = {

    // Create/Update record in `orders` table
    async createOrder(data){
        data               = this.normalizeDataValues(data);
        let give_coin_id   = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id   = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id    = await this.createCoin(data['GET_COIN']);
        let get_tick_id    = await this.createTicker(data['GET_TICK']);
        let get_address_id = await this.createAddress(data['GET_ADDRESS']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let give_amount    = data['GIVE_AMOUNT'];
        let get_amount     = data['GET_AMOUNT'];
        let give_ownership = (data['GIVE_OWNERSHIP']==1) ? 1 : 0;
        let get_ownership  = (data['GET_OWNERSHIP']==1)  ? 1 : 0;
        let expiration     = data['EXPIRATION'];
        let allow_list     = data['ALLOW_LIST'];
        let block_list     = data['BLOCK_LIST'];
        // Programmable policy: JSON [{to,bps}] royalty/fee split of the seller's proceeds (set as a
        // string by the handler from the create-side guard's payoutLegs; NULL = no split).
        let payout_legs    = (this.util.isNull(data['PAYOUT_LEGS'])) ? null : String(data['PAYOUT_LEGS']);
        // Check if record already exists for this order
        let query  = `SELECT
                            action_index
                        FROM
                            orders
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = ORDER_UPDATE_SQL;
            args = [give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, payout_legs, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO orders (give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, payout_legs, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, payout_legs, action_index];
        }
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `order_statuses` table
    // @param {action_index}      integer Action index of action
    // @param {order_action_tick} integer Action index of order
    // @param {status}            string  Status of the referenced order (open/complete/cancelled/expired)
    async createOrderStatus(action_index, order_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in order_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            order_statuses
                        WHERE
                            action_index=? AND
                            order_action_index=?`;
        let args = [action_index, order_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_statuses
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        order_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_statuses (status_id, action_index, order_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, order_action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `order_expires` table
    // @param {action_index}      integer Action index of action
    // @param {order_action_tick} integer Action index of order
    // @param {status}            string  Status of the expire (valid/invalid)
    async createOrderExpire(action_index, order_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in order_expires table
        let query  = `SELECT
                            action_index
                        FROM
                            order_expires
                        WHERE
                            action_index=? AND
                            order_action_index=?`;
        let args = [action_index, order_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_expires
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        order_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_expires (status_id, action_index, order_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, order_action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `order_edits` table
    async createOrderEdit(data){
        data                   = this.normalizeDataValues(data);
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        let action_index       = data['ACTION_INDEX'];
        let order_action_index = data['ORDER_ACTION_INDEX'];
        let expiration         = data['EXPIRATION'];
        let allow_list         = data['ALLOW_LIST'];
        let block_list         = data['BLOCK_LIST'];
        // Check if record already exists for this order_edits
        let query  = `SELECT
                            action_index
                        FROM
                            order_edits
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
                        order_edits
                    SET
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        order_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_edits (expiration, allow_list, block_list, memo_id, status_id, order_action_index, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [expiration, allow_list, block_list, memo_id, status_id, order_action_index, action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `order_cancels` table
    async createOrderCancel(data){
        data                  = this.normalizeDataValues(data);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let order_action_index = data['ORDER_ACTION_INDEX'];
        // Check if record already exists for this swap_cancel
        let query  = `SELECT
                            action_index
                        FROM
                            order_cancels
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
                        order_cancels
                    SET
                        memo_id=?,
                        status_id=?,
                        order_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_cancels (memo_id, status_id, order_action_index, action_index) values (?, ?, ?, ?)`;
        }
        args    = [memo_id, status_id, order_action_index, action_index];
        results = await this.doQuery(query, args);
    },

};

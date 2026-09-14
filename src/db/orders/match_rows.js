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
 * XChain Indexer - Database mixin part: orders (match rows)
 *
 * The order_matches rows: local matches, their COINPay status, cross-chain fills, and the reads that settle them.
 * A part of the orders mixin: src/db/orders.js merges it into the one method set that
 * db/index.js installs onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `order_matches` table
    async createOrderMatch(data, order, match){
        data                  = this.normalizeDataValues(data);
        let give_coin_id      = await this.createCoin(order['GIVE_COIN']);
        let give_tick_id      = await this.createTicker(order['GIVE_TICK']);
        let get_coin_id       = await this.createCoin(order['GET_COIN']);
        let get_tick_id       = await this.createTicker(order['GET_TICK']);
        let status_id         = await this.createStatus(data['STATUS']);
        let give_amount       = data['MATCH_GIVE_AMOUNT'];
        let get_amount        = data['MATCH_GET_AMOUNT'];
        let settlement_type   = data['SETTLEMENT_TYPE'] || 'instant';
        let action_index      = data['ACTION_INDEX'];
        let give_action_index = match['ACTION_INDEX']
        let get_action_index  = order['ACTION_INDEX'];
        // Check if record already exists for this order_matches
        let query  = `SELECT
                            action_index
                        FROM
                            order_matches
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
                        order_matches
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_action_index=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_action_index=?,
                        settlement_type=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_matches (give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, settlement_type, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, settlement_type, status_id, action_index];
        results = await this.doQuery(query, args);
    },

    // Set the lifecycle status of one `order_matches` row.
    // A COINPay match is written `pending_coinpay` and becomes `valid` when the
    // obligation settles; the status lives on the match row, not in order_statuses.
    async updateOrderMatchStatus(action_index, status){
        let status_id = await this.createStatus(status);
        let query = `UPDATE order_matches SET status_id=? WHERE action_index=?`;
        await this.doQuery(query, [status_id, action_index]);
    },

    // Get order action_indexes from an ORDER_MATCH
    // @param {match_action_index} integer The ORDER_MATCH action_index
    // Returns {give_action_index, get_action_index} or false
    async getOrderMatchOrders(match_action_index){
        let query = `SELECT
                        give_action_index,
                        get_action_index
                    FROM
                        order_matches
                    WHERE
                        action_index=?
                    LIMIT 1`;
        let args = [match_action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            return {
                give_action_index: Number(results[0].give_action_index),
                get_action_index:  Number(results[0].get_action_index)
            };
        }
        return false;
    },

    // Record a cross-chain ORDER partial fill in order_matches so getOrderAmountsRemaining
    // deducts it - the single source of truth for an order's remaining (local fills and
    // cross-chain fills both live here, so the offer book + completion logic stay consistent).
    // The local order is the GET side of the synthetic row (get_action_index = local order),
    // so the subtract loop maps give_amount→give_remaining and get_amount→get_remaining.
    // The cross counterparty has no local order, so give_action_index = the CROSS_SETTLE
    // action_index (rollback-able: a reorg drops this row and the order's remaining restores).
    async recordCrossChainOrderFill(settlement_action_index, order_action_index, give_amount, get_amount, give_coin, give_tick, get_coin, get_tick){
        let give_coin_id = await this.createCoin(give_coin);
        let get_coin_id  = await this.createCoin(get_coin);
        let give_tick_id = this.util.isNull(give_tick) ? null : await this.createTicker(give_tick);
        let get_tick_id  = this.util.isNull(get_tick)  ? null : await this.createTicker(get_tick);
        let status_id    = await this.createStatus('valid');
        let exists = await this.doQuery(`SELECT action_index FROM order_matches WHERE action_index=?`, [settlement_action_index]);
        if(exists.length > 0) return;                          // idempotent (one fill per settlement)
        await this.doQuery(
            `INSERT INTO order_matches (give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, settlement_type, status_id, action_index)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'instant', ?, ?)`,
            [give_coin_id, give_tick_id, give_amount, settlement_action_index, get_coin_id, get_tick_id, get_amount, order_action_index, status_id, settlement_action_index]);
    },

    // Get ORDER_MATCH give/get amounts
    // @param {match_action_index} integer The ORDER_MATCH action_index
    // Returns {give_action_index, get_action_index, give_amount, get_amount} or false
    async getOrderMatchAmounts(match_action_index){
        let query = `SELECT
                        give_action_index,
                        get_action_index,
                        give_amount,
                        get_amount
                    FROM
                        order_matches
                    WHERE
                        action_index=?
                    LIMIT 1`;
        let args = [match_action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            return {
                give_action_index: Number(results[0].give_action_index),
                get_action_index:  Number(results[0].get_action_index),
                give_amount:       results[0].give_amount,
                get_amount:        results[0].get_amount
            };
        }
        return false;
    },

};

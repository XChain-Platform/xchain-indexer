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
 * XChain Indexer - Database mixin part: orders (order info)
 *
 * The reads the matcher and settlement build an order from: candidate matches, the order row with its edits, and the amounts still open.
 * A part of the orders mixin: src/db/orders/index.js merges it into the one method set that
 * db/index.js installs onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// findOrderMatches' candidate query: every open order from another address that takes the
// other side of the order being matched. The text is unchanged; the reverse-leg notes ride
// inside it as SQL comments.
const ORDER_MATCH_CANDIDATES_SQL = `SELECT
                        c1.coin,
                        o2.action_index
                    FROM
                        orders o1,
                        orders o2
                        INNER JOIN index_coins    c1 ON (c1.id=o2.get_coin_id)
                        INNER JOIN actions        a1 ON (a1.action_index=o2.action_index)
                        INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN order_statuses s1 ON (s1.order_action_index=o2.action_index)
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                order_statuses s3
                            WHERE
                                s3.order_action_index=o2.action_index
                        ) AND
                        o1.give_coin_id=o2.get_coin_id AND
                        (o1.give_tick_id=o2.get_tick_id OR (o1.give_tick_id IS NULL AND o2.get_tick_id IS NULL)) AND
                        -- Reverse leg: what o1 GETS must be exactly what o2 GIVES. Without this the
                        -- predicate binds only the forward side (o1.give == o2.get), so a taker
                        -- offering o1.give could match a maker giving a DIFFERENT token than o1.get,
                        -- and order_match settlement (which hardcodes reciprocity via orderInfo.GET_TICK)
                        -- would credit the taker a token the maker never escrowed - minting it from the
                        -- global escrow pool while the maker's real token is stranded, and the
                        -- +credit / -phantom-escrow net to zero so the supply sanityCheck never trips.
                        -- NULL-safe like the give leg (native-coin sides carry a NULL tick).
                        o1.get_coin_id=o2.give_coin_id AND
                        -- Enforced only when both reverse ticks are real tokens (the instant
                        -- token-for-token path, where the mint bug lives). If either side is a
                        -- native-coin leg (NULL tick) the match routes through the two-phase
                        -- COINPay settlement, which is intentionally asymmetric, so leave it alone.
                        (o1.get_tick_id=o2.give_tick_id OR o1.get_tick_id IS NULL OR o2.give_tick_id IS NULL) AND
                        o1.action_index=? AND
                        a1.source_id!=? AND
                        s2.status='open'
                    ORDER BY
                        o2.action_index ASC`;

// getOrderAmountsRemaining's opening read: the amounts an order was created with, before
// the matched amounts are deducted.
const ORDER_OPENING_AMOUNTS_SQL = `SELECT
                        o.give_coin_id,
                        o.give_tick_id,
                        o.give_amount,
                        o.give_ownership,
                        o.get_coin_id,
                        o.get_tick_id,
                        o.get_amount,
                        o.get_ownership
                    FROM
                        orders o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE
                        o.action_index=? AND
                        s.status=?`;

// getOrderInfo's query. The coin filter is optional, so the statement is built per call;
// with or without it the text is the one the method issued inline.
function orderInfoSql(coin){
    return `SELECT
                        o1.action_index,
                        t2.tick as give_tick,
                        o1.give_amount,
                        o1.give_ownership,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        o1.get_amount,
                        o1.get_ownership,
                        a2.address as source,
                        a3.address as get_address,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        m1.memo,
                        s2.status,
                        s3.status as order_status,
                        o1.payout_legs,
                        b1.block_index,
                        b1.block_time
                    FROM
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        LEFT  JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=o1.get_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=o1.memo_id)
                        INNER JOIN order_statuses  s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  s2 ON (s2.id=o1.status_id)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                order_statuses s4
                            WHERE
                                s4.order_action_index=o1.action_index
                        ) AND
                        ${coin ? 'c1.coin=? AND' : ''}
                        o1.action_index=?
                    LIMIT 1`;
}

module.exports = {

    // Handle looking up potential order matches
    async findOrderMatches(data){
        let matches = false;
        // Normalize data
        let source_id    = await this.createAddress(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        // Lookup any matching orders from different addresses (not SOURCE)
        let query = ORDER_MATCH_CANDIDATES_SQL;
        let args = [action_index, source_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            // Loop through possible matches and get full information on the order match
            for(let row of results){
                let orderInfo = await this.getOrderInfo(row.coin, row.action_index);
                if(!matches)
                    matches = [];
                matches.push(orderInfo);
            }
        }
        // Sort matches by price, then by action_index
        if(matches)
            matches = this.util.sortPriceActionIndex(matches);
        return matches;
    },

    async getOrderInfo(coin, action_index){
        let order = false;
        let query = orderInfoSql(coin);
        let args  = coin ? [coin, action_index] : [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            order = {};
            order['GIVE_COIN'] = this.config['COIN'];
            for(let key in results[0]){
                let name  = String(key).toUpperCase()
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'GIVE_OWNERSHIP', 'GET_OWNERSHIP'].includes(name))
                    value = Number(value);
                order[name] = value;
            }
        }
        // Get additional information on this order
        if(order){
            // Get updated order properties from the order_edits table
            let edit = await this.getOrderEdits(action_index);
            if(edit.expiration)
                order['EXPIRATION'] = edit.expiration;
            if(edit.allow_list)
                order['ALLOW_LIST'] = edit.allow_list;
            if(edit.block_list)
                order['BLOCK_LIST'] = edit.block_list;
            // Ownership orders carry no amount on the ownership side. Expose virtual '1'
            // so price math + match comparison work uniformly. Settlement code branches on
            // GIVE_OWNERSHIP / GET_OWNERSHIP flags rather than the synthetic amount.
            if(order['GIVE_OWNERSHIP'] == 1 && this.util.isNull(order['GIVE_AMOUNT']))
                order['GIVE_AMOUNT'] = '1';
            if(order['GET_OWNERSHIP']  == 1 && this.util.isNull(order['GET_AMOUNT']))
                order['GET_AMOUNT']  = '1';
            // Determine order get/give prices
            order['GIVE_PRICE'] = this.util.getPrice(order['GET_AMOUNT'],  order['GIVE_AMOUNT']);
            order['GET_PRICE']  = this.util.getPrice(order['GIVE_AMOUNT'], order['GET_AMOUNT']);
            // Determine order amounts remaining
            let [give_remaining, get_remaining] = await this.getOrderAmountsRemaining(action_index);
            order['GIVE_REMAINING'] = give_remaining;
            order['GET_REMAINING']  = get_remaining;
        }
        return order;
    },

    // Return order edit information for given action_index
    async getOrderEdits(action_index){
        // Define empty edit object
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let query  = `SELECT 
                        o.expiration,
                        o.allow_list,
                        o.block_list
                    FROM 
                        order_edits o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE 
                        o.order_action_index=? AND
                        s.status=?
                    ORDER BY
                        o.action_index ASC`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = Number(row.expiration);
                if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = Number(row.allow_list);
                if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = Number(row.block_list);
            }
        }
        return edit;
    },

    // Handle getting total amounts remaining for a given order
    async getOrderAmountsRemaining(action_index){
        // Placeholders for amount escrowed and amount matched
        let give_coin_id   = 0,
            give_tick_id   = 0,
            give_remaining = 0,
            get_coin_id    = 0,
            get_tick_id    = 0,
            get_remaining  = 0;
        // Get initial amounts from the orders table
        let query  = ORDER_OPENING_AMOUNTS_SQL;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            let info = results[0];
            give_coin_id   = info.give_coin_id;
            give_tick_id   = info.give_tick_id;
            // Ownership orders carry no GIVE_AMOUNT/GET_AMOUNT in the schema; expose
            // virtual '1' so the matcher's bignumber math (price ratios, single-fill
            // subtraction) works uniformly with token-balance orders.
            give_remaining = (info.give_ownership == 1) ? '1' : info.give_amount;
            get_coin_id    = info.get_coin_id;
            get_tick_id    = info.get_tick_id;
            get_remaining  = (info.get_ownership  == 1) ? '1' : info.get_amount;
        }
        // Lookup amounts matched in order_matches
        query = `SELECT
                    m.give_action_index,
                    m.get_action_index,
                    m.give_amount,
                    m.get_amount
                FROM
                    order_matches m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    (m.give_action_index=? OR m.get_action_index=?) AND
                    s.status IN (?, ?)
                ORDER BY action_index ASC`;
        args = [action_index, action_index, 'valid', 'pending_coinpay'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            // Loop through each order match and deduct amount from remaining
            for(let row of results){
                let give_amount = (row.get_action_index==action_index) ? row.give_amount : row.get_amount;
                let get_amount  = (row.get_action_index==action_index) ? row.get_amount  : row.give_amount;
                give_remaining  = this.util.bcsub(give_remaining, give_amount, 64);
                get_remaining   = this.util.bcsub(get_remaining,  get_amount, 64);
            }
        }
        return [give_remaining, get_remaining];
    },

    // Return the SWEEP DESTINATION address if the most recent 'cancelling' status
    // row on the given order_action_index was triggered by a SWEEP, else null.
    // Used by coinpay.js / coinpay_expire.js to route residual escrow (or ownership)
    // to the sweeper's DESTINATION rather than the order's original SOURCE.
    async getOrderSweepDestination(order_action_index){
        let address = null;
        let query = `SELECT
                        a1.address
                    FROM
                        order_statuses    s1
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                        INNER JOIN sweeps           sw ON (sw.action_index=s1.action_index)
                        INNER JOIN index_statuses   s3 ON (s3.id=sw.status_id)
                        INNER JOIN index_addresses  a1 ON (a1.id=sw.destination_id)
                    WHERE
                        s1.order_action_index=? AND
                        s2.status='cancelling' AND
                        s3.status='valid'
                    ORDER BY
                        s1.action_index DESC
                    LIMIT 1`;
        let results = await this.doQuery(query, [order_action_index]);
        if(results.length > 0)
            address = results[0].address;
        return address;
    },

};

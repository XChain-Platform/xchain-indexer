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
 * XChain Indexer - Database mixin: orders
 * 
 * The queries over the orders table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');

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
            query = `UPDATE
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

    // Handle looking up potential order matches
    async findOrderMatches(data){
        let matches = false;
        // Normalize data
        let source_id    = await this.createAddress(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        // Lookup any matching orders from different addresses (not SOURCE)
        let query = `SELECT
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
        let query = `SELECT
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
        let query  = `SELECT
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

    // List this chain's OPEN cross-chain offers (SWAP + ORDER, give_coin != get_coin) for the
    // xchain-hub federation's unified matching view (XCC-2). SWAP and ORDER offers are drawn in a
    // single `UNION ALL` so ONE global `ORDER BY action_index ASC LIMIT ?` bounds the whole book
    // and the returned cursor is correct across both kinds - the previous per-kind LIMIT capped
    // swaps and orders independently, so a full page of one kind silently dropped the newest of
    // that kind while the concat lost the global keyset order. Every action carries a unique
    // global action_index (swaps and orders never collide), so the merged keyset is well defined.
    //
    // @param {limit}              integer Max rows over the merged book (caller clamps)
    // @param {after_action_index} integer Keyset cursor - return rows with action_index > this
    // @param {to_coin}            string  Optional filter: only offers whose GET_COIN equals this
    // @param {block_time}         integer Optional current block_time; when finite, offers already
    //                                     past their EFFECTIVE expiration (edit-overlaid, mirroring
    //                                     getExpiredItems: expired iff eff_expiration < block_time)
    //                                     are excluded so a stale 'open' offer awaiting its next
    //                                     block-loop expiry pass cannot occupy a bounded slot. A
    //                                     NULL/never expiration is always kept.
    //
    // Returns an array of merged offers (each tagged `kind`), carrying two out-of-band props:
    //   .truncated   - true when the page filled (rows === limit), so newer offers were dropped
    //                  and the hub must page/alarm instead of matching a partial book.
    //   .next_cursor - the largest action_index returned (feed back as after_action_index), or
    //                  null on an empty page.
    async getOpenCrossChainOffers(limit, after_action_index, to_coin, block_time){
        // Per-kind base filters: latest status is 'open' + cross-chain (give != get) + optional
        // to_coin. The effective-expiration overlay (last valid non-null edit wins, else base
        // expiration) mirrors getExpiredItems so the read filter agrees with the block loop's
        // own expiry rule. Each branch exposes the identical column list so UNION ALL is legal.
        let swapArgs  = [];
        let orderArgs = [];
        let swapWhere = [
            `ss.action_index = (SELECT MAX(s3.action_index) FROM swap_statuses s3 WHERE s3.swap_action_index=s1.action_index)`,
            `st.status='open'`,
            `s1.give_coin_id != s1.get_coin_id`
        ];
        let orderWhere = [
            `os.action_index = (SELECT MAX(s3.action_index) FROM order_statuses s3 WHERE s3.order_action_index=o1.action_index)`,
            `st.status='open'`,
            `o1.give_coin_id != o1.get_coin_id`
        ];
        // Guard null explicitly on the cursor too: Number(null) === 0 is finite, which would
        // append a pointless `action_index > 0` clause on the "no cursor" call.
        let hasCursor = !this.util.isNull(after_action_index) && Number.isFinite(Number(after_action_index));
        if(!this.util.isNull(to_coin)){ swapWhere.push(`cc.coin=?`);  swapArgs.push(to_coin); }
        if(hasCursor){ swapWhere.push(`s1.action_index>?`); swapArgs.push(Number(after_action_index)); }
        if(!this.util.isNull(to_coin)){ orderWhere.push(`cc.coin=?`); orderArgs.push(to_coin); }
        if(hasCursor){ orderWhere.push(`o1.action_index>?`); orderArgs.push(Number(after_action_index)); }
        let swapBranch = `SELECT
                        'swap' as kind,
                        s1.action_index,
                        gc.coin    as give_coin,
                        gt.tick    as give_tick,
                        s1.give_amount,
                        s1.give_ownership,
                        cc.coin    as get_coin,
                        rt.tick    as get_tick,
                        s1.get_amount,
                        s1.get_ownership,
                        ga.address as get_address,
                        sa.address as source,
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list,
                        s1.payout_legs,
                        t1.block_index,
                        COALESCE((SELECT se.expiration FROM swap_edits se INNER JOIN index_statuses ses ON (ses.id=se.status_id) WHERE se.swap_action_index=s1.action_index AND ses.status='valid' AND se.expiration IS NOT NULL ORDER BY se.action_index DESC LIMIT 1), s1.expiration) as effective_expiration
                    FROM
                        swaps s1
                        INNER JOIN actions         a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_addresses sa ON (sa.id=a1.source_id)
                        INNER JOIN index_addresses ga ON (ga.id=s1.get_address_id)
                        INNER JOIN index_coins     gc ON (gc.id=s1.give_coin_id)
                        INNER JOIN index_coins     cc ON (cc.id=s1.get_coin_id)
                        INNER JOIN index_tickers   gt ON (gt.id=s1.give_tick_id)
                        LEFT  JOIN index_tickers   rt ON (rt.id=s1.get_tick_id)
                        INNER JOIN swap_statuses   ss ON (ss.swap_action_index=s1.action_index)
                        INNER JOIN index_statuses  st ON (st.id=ss.status_id)
                    WHERE ` + swapWhere.join(' AND ');
        let orderBranch = `SELECT
                        'order' as kind,
                        o1.action_index,
                        gc.coin    as give_coin,
                        gt.tick    as give_tick,
                        o1.give_amount,
                        o1.give_ownership,
                        cc.coin    as get_coin,
                        rt.tick    as get_tick,
                        o1.get_amount,
                        o1.get_ownership,
                        ga.address as get_address,
                        sa.address as source,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        o1.payout_legs,
                        t1.block_index,
                        COALESCE((SELECT oe.expiration FROM order_edits oe INNER JOIN index_statuses oes ON (oes.id=oe.status_id) WHERE oe.order_action_index=o1.action_index AND oes.status='valid' AND oe.expiration IS NOT NULL ORDER BY oe.action_index DESC LIMIT 1), o1.expiration) as effective_expiration
                    FROM
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_addresses sa ON (sa.id=a1.source_id)
                        INNER JOIN index_addresses ga ON (ga.id=o1.get_address_id)
                        INNER JOIN index_coins     gc ON (gc.id=o1.give_coin_id)
                        INNER JOIN index_coins     cc ON (cc.id=o1.get_coin_id)
                        LEFT  JOIN index_tickers   gt ON (gt.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   rt ON (rt.id=o1.get_tick_id)
                        INNER JOIN order_statuses  os ON (os.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  st ON (st.id=os.status_id)
                    WHERE ` + orderWhere.join(' AND ');
        // Merge, then apply the expiration filter + global keyset order + single LIMIT on the
        // unified set (args ordered: swap branch, order branch, [expiration], limit).
        let args = swapArgs.concat(orderArgs);
        let outerWhere = '';
        // Guard null/undefined explicitly: Number(null) === 0 is finite, which would wrongly
        // apply a `>= 0` filter (a no-op that still diverges from the "no filter" contract).
        if(!this.util.isNull(block_time) && Number.isFinite(Number(block_time))){
            outerWhere = ` WHERE (u.effective_expiration IS NULL OR u.effective_expiration >= ?)`;
            args.push(Number(block_time));
        }
        let query = `SELECT * FROM (
                        ` + swapBranch + `
                        UNION ALL
                        ` + orderBranch + `
                    ) u` + outerWhere + `
                    ORDER BY u.action_index ASC
                    LIMIT ?`;
        args.push(Number(limit));
        let results = await this.doQuery(query, args);
        let offers = [];
        for(let row of results){
            let isOwnGive = (Number(row.give_ownership) === 1 && this.util.isNull(row.give_amount));
            let isOwnGet  = (Number(row.get_ownership)  === 1 && this.util.isNull(row.get_amount));
            let offer = {
                kind:           (row.kind === 'order') ? 'order' : 'swap',
                action_index:   Number(row.action_index),
                give_coin:      row.give_coin,
                give_tick:      row.give_tick,
                // Ownership offers carry no amount - expose virtual '1' so the hub's committed
                // ledger + amount compare work uniformly (matches getOrderInfo's convention).
                give_amount:    isOwnGive ? '1' : row.give_amount,
                give_ownership: Number(row.give_ownership),
                get_coin:       row.get_coin,
                get_tick:       row.get_tick,
                get_amount:     isOwnGet ? '1' : row.get_amount,
                get_ownership:  Number(row.get_ownership),
                get_address:    row.get_address,
                source:         row.source,
                expiration:     Number(row.expiration),
                allow_list:     row.allow_list,
                block_list:     row.block_list,
                // Controller-guard royalty split (JSON [{to,bps}] or null). The hub copies it
                // into the match row so settlement can apply it on the proceeds chain.
                payout_legs:    row.payout_legs || null,
                block_index:    Number(row.block_index)
            };
            if(offer.kind === 'order'){
                // Remaining (give/get) reflects all fills - local order_matches AND cross-chain
                // settlements (both recorded in order_matches) - so the hub's reservation is exact.
                let [give_remaining, get_remaining] = await this.getOrderAmountsRemaining(row.action_index);
                offer.give_remaining = String(give_remaining);
                offer.get_remaining  = String(get_remaining);
            }
            offers.push(offer);
        }
        // Surface truncation the same way the validator-set RPCs do: a full page means the OLDEST
        // `limit` open cross-chain offers were returned and newer ones are absent, so the hub can
        // page (via next_cursor) or alarm rather than silently matching against a partial book.
        // Results are ORDER BY action_index ASC, so the last row carries the max action_index.
        offers.truncated   = results.length >= Number(limit);
        offers.next_cursor = results.length > 0 ? Number(results[results.length - 1].action_index) : null;
        return offers;
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

    // Handle getting information on a given market
    async getMarketInfo(market_id, block_time){
        // Define response object
        let data = {
            tick1_price       : 0,
            tick1_bid         : 0,
            tick1_ask         : 0,
            tick1_24hr_price  : 0,
            tick1_24hr_high   : 0,
            tick1_24hr_low    : 0,
            tick1_24hr_change : 0,
            tick1_24hr_volume : 0,
            tick2_price       : 0,
            tick2_bid         : 0,
            tick2_ask         : 0,
            tick2_24hr_price  : 0,
            tick2_24hr_high   : 0,
            tick2_24hr_low    : 0,
            tick2_24hr_change : 0,
            tick2_24hr_volume : 0,
        };
        // Get the time right now and the time 24 hours ago
        let time_now  = block_time,
            time_24hr = this.util.bcsub(time_now, 86400);
        // Set the last time this info was updated to now
        data.last_updated = time_now;
        // A side's tick id as `markets` keys it. orders/order_matches store NULL where
        // the side is the native coin, so every comparison against a markets-side id
        // below has to translate first or it silently matches nothing.
        const sideOf = (tick_id) => Database.marketTickId(tick_id);
        // Lookup basic information on this market (tick, tick_id, decimals).
        // LEFT joins throughout: a side that is the native coin has no tokens row and no
        // index_tickers row, and an inner join on either dropped the whole market, which
        // left its price, bid, ask and 24h stats pinned at the zeroes above.
        let query = `SELECT
                            m1.id       as market_id,
                            COALESCE(t3.tick, c1.coin) as tick1,
                            m1.tick1_id as tick1_id,
                            COALESCE(t1.decimals, ?)   as tick1_decimals,
                            COALESCE(t4.tick, c2.coin) as tick2,
                            m1.tick2_id as tick2_id,
                            COALESCE(t2.decimals, ?)   as tick2_decimals,
                            m1.coin1_id as coin1_id,
                            m1.coin2_id as coin2_id
                        FROM
                            markets m1
                            LEFT JOIN tokens        t1 ON (t1.tick_id=m1.tick1_id)
                            LEFT JOIN tokens        t2 ON (t2.tick_id=m1.tick2_id)
                            LEFT JOIN index_tickers t3 ON (t3.id=m1.tick1_id)
                            LEFT JOIN index_tickers t4 ON (t4.id=m1.tick2_id)
                            LEFT JOIN index_coins   c1 ON (c1.id=m1.coin1_id)
                            LEFT JOIN index_coins   c2 ON (c2.id=m1.coin2_id)
                        WHERE
                            m1.id=?`;
        let args  = [Database.MARKET_NATIVE_DECIMALS, Database.MARKET_NATIVE_DECIMALS, market_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            let row = results[0];
            // Convert the ids from BIGINT to Number
            row.market_id = Number(row.market_id);
            row.tick1_id  = Number(row.tick1_id);
            row.tick2_id  = Number(row.tick2_id);
            row.coin1_id  = Number(row.coin1_id) || 0;
            row.coin2_id  = Number(row.coin2_id) || 0;
            Object.assign(data, row);
            // The ageing sweep (getStaleMarkets) never goes through createMarket, so a
            // pair that stopped trading before the coin columns existed has no other way
            // back to a labelled row. Derive the two coins from the pair's own earliest
            // order, oriented to the way the row stores its sides; updateMarketInfo
            // persists them. Guarded on the 0, so a labelled row costs no extra query.
            if(data.coin1_id===0 || data.coin2_id===0){
                let coins = await this.doQuery(
                    `SELECT o.give_tick_id, o.give_coin_id, o.get_coin_id
                     FROM orders o
                     WHERE o.give_coin_id=o.get_coin_id AND
                           ((COALESCE(o.give_tick_id,0)=? AND COALESCE(o.get_tick_id,0)=?)
                         OR (COALESCE(o.give_tick_id,0)=? AND COALESCE(o.get_tick_id,0)=?))
                     ORDER BY o.action_index ASC
                     LIMIT 1`,
                    [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id]);
                if(coins.length > 0){
                    let give_is_tick1 = (sideOf(coins[0].give_tick_id)===data.tick1_id);
                    data.coin1_id = Number(give_is_tick1 ? coins[0].give_coin_id : coins[0].get_coin_id)  || 0;
                    data.coin2_id = Number(give_is_tick1 ? coins[0].get_coin_id  : coins[0].give_coin_id) || 0;
                }
            }
        }
        // Lookup last trade prices
        query = `SELECT
                m1.give_tick_id,
                m1.give_amount,
                m1.get_tick_id,
                m1.get_amount
            FROM 
                order_matches m1
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
            WHERE
                m1.give_coin_id=m1.get_coin_id AND 
                ((COALESCE(m1.give_tick_id,0)=? AND COALESCE(m1.get_tick_id,0)=?) OR (COALESCE(m1.give_tick_id,0)=? AND COALESCE(m1.get_tick_id,0)=?))  AND
                s1.status=?
            ORDER BY m1.action_index DESC 
            LIMIT 1`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let row = results[0];
            let give_amount = (sideOf(row.give_tick_id)===data.tick1_id) ? row.give_amount : row.get_amount;
            let get_amount  = (sideOf(row.give_tick_id)===data.tick1_id) ? row.get_amount  : row.give_amount;
            data.tick1_price = this.util.getPrice(get_amount, give_amount);
            data.tick2_price = this.util.getPrice(give_amount, get_amount);
        }
        // Lookup trade prices 24-hours ago
        query = `SELECT
                m1.give_tick_id,
                m1.give_amount,
                m1.get_tick_id,
                m1.get_amount
            FROM 
                order_matches m1
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
                INNER JOIN actions        a1 ON (a1.action_index=m1.action_index)
                INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
            WHERE
                m1.give_coin_id=m1.get_coin_id AND 
                ((COALESCE(m1.give_tick_id,0)=? AND COALESCE(m1.get_tick_id,0)=?) OR (COALESCE(m1.give_tick_id,0)=? AND COALESCE(m1.get_tick_id,0)=?))  AND
                s1.status=? AND
                b1.block_time <= ?
            ORDER BY m1.action_index DESC 
            LIMIT 1`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', time_24hr];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let row = results[0];
            let give_amount = (sideOf(row.give_tick_id)===data.tick1_id) ? row.give_amount : row.get_amount;
            let get_amount  = (sideOf(row.give_tick_id)===data.tick1_id) ? row.get_amount  : row.give_amount;
            data.tick1_24hr_price = this.util.getPrice(get_amount, give_amount);
            data.tick2_24hr_price = this.util.getPrice(give_amount, get_amount);
        }
        // Lookup 'bid' prices
        query = `SELECT
                o1.give_tick_id,
                o1.give_amount,
                o1.get_tick_id,
                o1.get_amount
            FROM 
                orders o1
                INNER JOIN order_statuses s1 ON (s1.order_action_index=o1.action_index)
                INNER JOIN index_statuses s2 ON (s2.id=o1.status_id)
                INNER JOIN index_statuses s3 ON (s3.id=s1.status_id)
            WHERE
                o1.give_coin_id=o1.get_coin_id AND 
                ((COALESCE(o1.give_tick_id,0)=? AND COALESCE(o1.get_tick_id,0)=?) OR (COALESCE(o1.give_tick_id,0)=? AND COALESCE(o1.get_tick_id,0)=?))  AND
                s2.status=? AND
                s3.status=? AND
                s1.action_index = (
                    SELECT
                        MAX(s4.action_index)
                    FROM
                        order_statuses s4
                    WHERE
                        s4.order_action_index = o1.action_index
                )
            ORDER BY o1.action_index DESC`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', 'open'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let tick1_bid = 0,
                tick2_bid = 0;
            for(let row of results){
                let give_amount = (sideOf(row.give_tick_id)===data.tick1_id) ? row.give_amount : row.get_amount;
                let get_amount  = (sideOf(row.give_tick_id)===data.tick1_id) ? row.get_amount : row.give_amount;
                let price1      = this.util.getPrice(get_amount, give_amount);
                let price2      = this.util.getPrice(give_amount, get_amount);
                if(price1==0||price2==0)
                    continue;
                if(tick1_bid==0) tick1_bid = price1;
                if(tick2_bid==0) tick2_bid = price2;
                // bcgt, not `>`: getPrice returns a decimal.js bignumber, and a native
                // relational compare between two of them coerces both to strings and ranks
                // them LEXICOGRAPHICALLY, so '10' sorts below '9'. Same disagreement the SQL
                // side flag-dayed in dispenser_send_amount_compare_activation.js.
                if(this.util.bcgt(price1, tick1_bid)) tick1_bid = price1;
                if(this.util.bcgt(price2, tick2_bid)) tick2_bid = price2;
            }
            data.tick1_bid  = tick1_bid;
            data.tick2_bid  = tick2_bid;
        }
        // Lookup 'ask' prices
        query = `SELECT
                o1.give_tick_id,
                o1.give_amount,
                o1.get_tick_id,
                o1.get_amount
            FROM 
                orders o1
                INNER JOIN order_statuses s1 ON (s1.order_action_index=o1.action_index)
                INNER JOIN index_statuses s2 ON (s2.id=o1.status_id)
                INNER JOIN index_statuses s3 ON (s3.id=s1.status_id)
            WHERE
                o1.give_coin_id=o1.get_coin_id AND 
                ((COALESCE(o1.give_tick_id,0)=? AND COALESCE(o1.get_tick_id,0)=?) OR (COALESCE(o1.give_tick_id,0)=? AND COALESCE(o1.get_tick_id,0)=?))  AND
                s2.status=? AND
                s3.status=? AND
                s1.action_index = (
                    SELECT
                        MAX(s4.action_index)
                    FROM
                        order_statuses s4
                    WHERE
                        s4.order_action_index = o1.action_index
                )
            ORDER BY o1.action_index DESC`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', 'open'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let tick1_ask = 0,
                tick2_ask = 0;
            for(let row of results){
                let give_amount = (sideOf(row.give_tick_id)===data.tick1_id) ? row.give_amount : row.get_amount;
                let get_amount  = (sideOf(row.give_tick_id)===data.tick1_id) ? row.get_amount : row.give_amount;
                let price1      = this.util.getPrice(get_amount, give_amount);
                let price2      = this.util.getPrice(give_amount, get_amount);
                if(price1==0||price2==0)
                    continue;
                if(tick1_ask==0) tick1_ask = price1;
                if(tick2_ask==0) tick2_ask = price2;
                // bclt for the same reason as the bid block above: a lexicographic rank picks
                // the wrong extreme here, which publishes an understated ask.
                if(this.util.bclt(price1, tick1_ask)) tick1_ask = price1;
                if(this.util.bclt(price2, tick2_ask)) tick2_ask = price2;
            }
            data.tick1_ask = tick1_ask;
            data.tick2_ask = tick2_ask;
        }
        // Lookup all order matches in the last 24-hours
        query = `SELECT
                m1.give_tick_id,
                m1.give_amount,
                m1.get_tick_id,
                m1.get_amount
            FROM 
                order_matches m1
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
                INNER JOIN actions        a1 ON (a1.action_index=m1.action_index)
                INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
            WHERE
                m1.give_coin_id=m1.get_coin_id AND 
                ((COALESCE(m1.give_tick_id,0)=? AND COALESCE(m1.get_tick_id,0)=?) OR (COALESCE(m1.give_tick_id,0)=? AND COALESCE(m1.get_tick_id,0)=?))  AND
                s1.status=? AND
                b1.block_time >= ?
            ORDER BY m1.action_index DESC`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', time_24hr];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let tick1_high   = 0,
                tick1_low    = 0,
                tick1_volume = 0,
                tick2_high   = 0,
                tick2_low    = 0,
                tick2_volume = 0;
            // Scale each volume accumulator sums at, from the decimals the market lookup
            // above already selected. Clamped to [0,18] like getTokenDecimalPrecision, so a
            // missing or junk column value can never widen or negate the precision.
            let tick1_decimals = Math.max(0, Math.min(18, parseInt(data.tick1_decimals) || 0));
            let tick2_decimals = Math.max(0, Math.min(18, parseInt(data.tick2_decimals) || 0));
            for(let row of results){
                let give_amount = (sideOf(row.give_tick_id)===data.tick1_id) ? row.give_amount : row.get_amount;
                let get_amount  = (sideOf(row.give_tick_id)===data.tick1_id) ? row.get_amount : row.give_amount;
                let price1      = this.util.getPrice(get_amount, give_amount);
                let price2      = this.util.getPrice(give_amount, get_amount);
                // Set tick high/low prices
                if(tick1_high==0 && tick1_low==0){
                    tick1_high = price1;
                    tick1_low  = price1;
                }
                if(tick2_high==0 && tick2_low==0){
                    tick2_high = price2;
                    tick2_low  = price2;
                }
                // 24-hour high (bcgt/bclt: these are bignumbers, see the bid block above)
                if(this.util.bcgt(price1, tick1_high)) tick1_high = price1;
                if(this.util.bcgt(price2, tick2_high)) tick2_high = price2;
                // 24-hour low
                if(this.util.bclt(price1, tick1_low)) tick1_low = price1;
                if(this.util.bclt(price2, tick2_low)) tick2_low = price2;
                // 24-hour volumes, summed at each tick's own scale. bcadd with the decimals
                // argument omitted formats at precision 0, which quantizes every partial sum
                // to a whole unit: a market of sub-unit fills accumulated to 0.
                tick1_volume = this.util.bcadd(tick1_volume, give_amount, tick1_decimals);
                tick2_volume = this.util.bcadd(tick2_volume, get_amount, tick2_decimals);
            }
            data.tick1_24hr_high   = tick1_high;
            data.tick1_24hr_low    = tick1_low;
            data.tick1_24hr_volume = tick1_volume;
            data.tick2_24hr_high   = tick2_high;
            data.tick2_24hr_low    = tick2_low;
            data.tick2_24hr_volume = tick2_volume;
        }
        // Calculate 24-hour price change percentage
        let tick1_change = 0.00;
        let tick2_change = 0.00;
        if(this.util.bcgt(data.tick1_price, 0) && this.util.bcgt(data.tick1_24hr_price, 0))
            tick1_change = this.util.bcmul(this.util.bcdiv(this.util.bcsub(data.tick1_price, data.tick1_24hr_price,8), data.tick1_24hr_price,8), 100, 2);
        if(this.util.bcgt(data.tick2_price, 0) && this.util.bcgt(data.tick2_24hr_price, 0))
            tick2_change = this.util.bcmul(this.util.bcdiv(this.util.bcsub(data.tick2_price, data.tick2_24hr_price,8), data.tick2_24hr_price,8), 100, 2);
        data.tick1_24hr_change = tick1_change;
        data.tick2_24hr_change = tick2_change;
        // Sort the market data object 
        data = this.util.ksort(data);
        return data;
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

// The class these methods install onto, read for its statics. The require sits below
// module.exports so the two files load in either order: whichever runs first, the
// other already sees a finished export by the time a method body runs.
const Database = require('./index.js');

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
 * XChain Indexer - Database mixin: markets
 * 
 * The queries over the markets table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');

module.exports = {

    // Lookup market pairs by block
    // TODO: Circle back and add support for cross-chain market data (different coin_id)
    async getMarkets(block_index, update){
        let markets    = [];
        // Orientation-free keys of the pairs already collected, so the dedupe below is a lookup
        // instead of a full rescan of `markets` per row (the old scan never broke on a hit, so
        // the cost was O(rows x pairs) on the block path). Spans every order type, matching the
        // array it shadows. A tickerless (native-coin) side keys on 0, the same sentinel it is
        // stored under, so a token/native pair dedupes like any other instead of being pushed
        // once per order.
        let marketKeys = new Set();
        let args       = [block_index];
        let counts     = false;
        let query      = '';
        let where      = 'b1.block_index=? AND ';
        // Get the time right now and the time 24 hours ago
        let time_now   = await this.getBlockTime(block_index),
            time_24hr  = this.util.bcsub(time_now, 86400);
        // Quickly check if we have any ORDER, ORDER_MATCH, ORDER_EXPIRE, or ORDER_CANCEL events for the given block
        query = `SELECT
                    count(*) as count,
                    a2.action as type
                FROM
                    actions a1
                    INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                WHERE
                    a1.block_index=? AND
                    a2.action IN ('ORDER','ORDER_MATCH','ORDER_EXPIRE','ORDER_CANCEL')
                GROUP BY a2.action
                ORDER BY a2.action`;
        counts = await this.doQuery(query, args);
        // Updates to find markets which have not been updated in the last 24 hours
        if(update){
            where = `(a1.block_index=? OR b1.block_time < ? ) AND `;
            let types = ['ORDER','ORDER_MATCH','ORDER_EXPIRE','ORDER_CANCEL'];
            for(let type of types){
                let found = false;
                for(let item of counts){
                    if(item.type==type)
                        found = true;
                }
                if(!found){
                    counts.push({
                        count: 1,
                        type: type
                    });
                }
            }
        }
        // Loop through order action types and get list of market pairs
        for(let info of counts){
            let pairs = [],
                query = false,
                type  = info.type,
                table = String(type).toLowerCase() + ((type.includes('_MATCH')) ? 'es' : 's');
            // Set the arguments
            if(update){
                args = [block_index, time_24hr, 'valid'];
            } else {
                args = [block_index, 'valid'];
            }
            if(['ORDER','ORDER_MATCH'].includes(type)){
                query = `SELECT
                            o1.action_index,
                            o1.get_tick_id  as tick1_id,
                            o1.give_tick_id as tick2_id,
                            o1.get_coin_id  as coin1_id,
                            o1.give_coin_id as coin2_id
                        FROM
                            ` + table + ` o1
                            INNER JOIN actions        a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN index_coins    c1 ON (c1.id=o1.give_coin_id)
                            INNER JOIN index_statuses s1 ON (s1.id=o1.status_id)
                        WHERE
                            ` + where + `
                            o1.give_coin_id=o1.get_coin_id AND
                            s1.status=?
                        ORDER BY o1.action_index ASC`;
            } else if(['ORDER_CANCEL','ORDER_EXPIRE'].includes(type)){
                query = `SELECT
                            o1.action_index,
                            o2.get_tick_id  as tick1_id,
                            o2.give_tick_id as tick2_id,
                            o2.get_coin_id  as coin1_id,
                            o2.give_coin_id as coin2_id
                        FROM
                            ` + table + ` o1
                            INNER JOIN orders         o2 ON (o2.action_index=o1.order_action_index)
                            INNER JOIN actions        a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN index_statuses s1 ON (s1.id=o1.status_id)
                        WHERE
                            ` + where + `
                            s1.status=?
                        ORDER BY o1.action_index ASC`;
            }
            if(query){
                let results = await this.doQuery(query, args);
                if(results.length > 0){
                    for(let row of results){
                        // Check if this pair already exists (either orientation). A tickerless
                        // side reads as 0 (Database.MARKET_NATIVE_TICK_ID), which is what the
                        // markets row stores for it, so the key below is the stored identity.
                        let tick1_id = Database.marketTickId(row.tick1_id);
                        let tick2_id = Database.marketTickId(row.tick2_id);
                        let coin1_id = Number(row.coin1_id);
                        let coin2_id = Number(row.coin2_id);
                        let key      = Math.min(tick1_id, tick2_id) + ':' + Math.max(tick1_id, tick2_id);
                        if(!marketKeys.has(key)){
                            marketKeys.add(key);
                            markets.push({ tick1_id, tick2_id, coin1_id, coin2_id });
                        }
                    }
                }
           }
        }
        return markets;
    },

    // The `markets` row for a pair in either stored orientation, or null. Carries the
    // stored tick1_id and coin ids so a caller can tell a labelled row apart from one
    // written before `markets` named the coin behind a tickerless side.
    // A tickerless side is passed as Database.MARKET_NATIVE_TICK_ID (0), never NULL:
    // `m.tick1_id=NULL` is never true in SQL, so a NULL argument here reported "no such
    // market" for a pair that existed and createMarket() inserted a fresh row per order.
    async getMarketRow(tick1_id, tick2_id){
        let query  = `SELECT
                            id,
                            tick1_id,
                            coin1_id,
                            coin2_id
                        FROM
                            markets m
                        WHERE
                            (m.tick1_id=? AND m.tick2_id=?) OR
                            (m.tick1_id=? AND m.tick2_id=?)`;
        let args = [Database.marketTickId(tick1_id), Database.marketTickId(tick2_id),
                    Database.marketTickId(tick2_id), Database.marketTickId(tick1_id)];
        let results = await this.doQuery(query, args);
        return (results.length > 0) ? results[0] : null;
    },

    // Create record in `markets` table
    async createMarket(tick1_id, tick2_id, coin1_id, coin2_id){
        let row = await this.getMarketRow(tick1_id, tick2_id);
        let id  = (row) ? row.id : null;
        let t1  = Database.marketTickId(tick1_id);
        let t2  = Database.marketTickId(tick2_id);
        let c1  = Number(coin1_id) || 0;
        let c2  = Number(coin2_id) || 0;
        if(id==null){
            // ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id) makes a concurrent
            // insert of the same pair a no-op while still returning the existing
            // row's id via insertId. Combined with the UNIQUE(tick1_id, tick2_id)
            // key this prevents two rows ever being created for the same pair if
            // two inserts race past the getMarketRow check above. The coin ids ride
            // the update clause so a row a racing insert already created is labelled
            // too.
            let query = `INSERT INTO markets (tick1_id, tick2_id, coin1_id, coin2_id) values (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id),
                                                 coin1_id = VALUES(coin1_id),
                                                 coin2_id = VALUES(coin2_id)`;
            let args  = [t1, t2, c1, c2];
            let results = await this.doQuery(query, args);
            if(results.insertId)
                id = Number(results.insertId);
        } else if(c1 && c2 && (Number(row.coin1_id)===0 || Number(row.coin2_id)===0)){
            // Self-heal. Every markets row that predates coin1_id/coin2_id carries 0 on
            // both sides, and the INSERT above never runs for it, so without this the row
            // stays unlabelled until an operator runs the tracked migration and the API
            // cannot name the tickerless side of the pair. The CASE keys the two coin ids
            // to the row's OWN orientation, because getMarketRow matches either. The WHERE
            // repeats the guard so a concurrent heal writing the same labels is a no-op.
            let query = `UPDATE markets
                         SET coin1_id = CASE WHEN tick1_id=? THEN ? ELSE ? END,
                             coin2_id = CASE WHEN tick1_id=? THEN ? ELSE ? END
                         WHERE id=? AND (coin1_id=0 OR coin2_id=0)`;
            let args  = [t1, c1, c2, t1, c2, c1, id];
            await this.doQuery(query, args);
        }
        return id;
    },

    // Update market information for a given market_id
    async updateMarketInfo(data){
        let market_id    = data.market_id;
        let tick1_price       = data.tick1_price;
        let tick1_bid         = data.tick1_bid;
        let tick1_ask         = data.tick1_ask;
        let tick1_24hr_price  = data.tick1_24hr_price;
        let tick1_24hr_high   = data.tick1_24hr_high;
        let tick1_24hr_low    = data.tick1_24hr_low;
        let tick1_24hr_change = data.tick1_24hr_change;
        let tick1_24hr_volume = data.tick1_24hr_volume;
        let tick2_price       = data.tick2_price;
        let tick2_bid         = data.tick2_bid;
        let tick2_ask         = data.tick2_ask;
        let tick2_24hr_price  = data.tick2_24hr_price;
        let tick2_24hr_high   = data.tick2_24hr_high;
        let tick2_24hr_low    = data.tick2_24hr_low;
        let tick2_24hr_change = data.tick2_24hr_change;
        let tick2_24hr_volume = data.tick2_24hr_volume;
        let last_updated      = data.last_updated;
        // Written only when getMarketInfo resolved BOTH coins. A row it could not label
        // (no surviving order for the pair) keeps whatever it has rather than being
        // rewritten to 0, and a caller that built `data` without them is unaffected.
        let coin1_id          = Number(data.coin1_id) || 0;
        let coin2_id          = Number(data.coin2_id) || 0;
        let label             = (coin1_id > 0 && coin2_id > 0);
        let query = `UPDATE
                        markets
                    SET
                        tick1_price=?,
                        tick1_bid=?,
                        tick1_ask=?,
                        tick1_24hr_price=?,
                        tick1_24hr_high=?,
                        tick1_24hr_low=?,
                        tick1_24hr_change=?,
                        tick1_24hr_volume=?,
                        tick2_price=?,
                        tick2_bid=?,
                        tick2_ask=?,
                        tick2_24hr_price=?,
                        tick2_24hr_high=?,
                        tick2_24hr_low=?,
                        tick2_24hr_change=?,
                        tick2_24hr_volume=?,
                        last_updated=?` + (label ? `,
                        coin1_id=?,
                        coin2_id=?` : ``) + `
                    WHERE
                        id=?`;
        let args    = [tick1_price, tick1_bid, tick1_ask, tick1_24hr_price, tick1_24hr_high, tick1_24hr_low, tick1_24hr_change, tick1_24hr_volume, tick2_price, tick2_bid, tick2_ask, tick2_24hr_price, tick2_24hr_high, tick2_24hr_low, tick2_24hr_change, tick2_24hr_volume, last_updated];
        if(label)
            args.push(coin1_id, coin2_id);
        args.push(market_id);
        let results = await this.doQuery(query, args);
    },

    // Bounded batch of the most-stale existing market rows for the throttled 24h rolling-stats
    // ageing sweep (processMarketUpdates). Returns market ids whose stats were last refreshed
    // before `time_24hr` (NULL = never), oldest-first, capped at `limit`, so per-block refresh
    // cost is bounded by the cap rather than the total active-market count. The `markets` table is
    // unhashed / snapshot-replicated with no consensus reader (see rollback.js IDX-2), so a
    // node-local sweep cadence cannot diverge block state. ORDER BY (last_updated, id) is stable.
    async getStaleMarkets(time_24hr, limit){
        let max = Number(limit);
        if(!Number.isFinite(max) || max <= 0) max = 25;
        let rows = await this.doQuery(
            `SELECT id
             FROM markets
             WHERE last_updated IS NULL OR last_updated < ?
             ORDER BY (last_updated IS NULL) DESC, last_updated ASC, id ASC
             LIMIT ?`,
            [time_24hr, max]);
        return rows || [];
    },

};

// The class these methods install onto, read for its statics. The require sits below
// module.exports so the two files load in either order: whichever runs first, the
// other already sees a finished export by the time a method body runs.
const Database = require('./index.js');

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
 * XChain Indexer - Database mixin part: markets / market_pairs
 *
 * The market pairs a block touched, collected from its order-family actions.
 * Merged into the markets mixin by db/markets.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

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
        let where      = 'b1.block_index=? AND ';
        // Get the time right now and the time 24 hours ago
        let time_now   = await this.getBlockTime(block_index),
            time_24hr  = this.util.bcsub(time_now, 86400);
        // Quickly check if we have any ORDER, ORDER_MATCH, ORDER_EXPIRE, or ORDER_CANCEL events for the given block
        counts = await pairScan.orderActionCounts(this, args);
        // Updates to find markets which have not been updated in the last 24 hours
        if(update){
            where = `(a1.block_index=? OR b1.block_time < ? ) AND `;
            pairScan.padUpdateCounts(counts);
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
            query = pairScan.pairQuery(type, table, where);
            if(query){
                let results = await this.doQuery(query, args);
                if(results.length > 0)
                    pairScan.collectPairs(results, marketKeys, markets);
           }
        }
        return markets;
    },

};

// The passes of getMarkets, kept off the exported object so Database.prototype gains no
// method: the per-block count of order-family actions, the padding that makes an update
// sweep visit every type, the per-type pair statement and the orientation-free dedupe.
const pairScan = {

    async orderActionCounts(db, args){
        let query = `SELECT
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
        return await db.doQuery(query, args);
    },

    // An update sweep revisits every order type, so a type with no action this block
    // still gets a placeholder count row.
    padUpdateCounts(counts){
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
    },

    // The pair statement for one order-family type, or false for a type that has none.
    pairQuery(type, table, where){
        let query = false;
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
        return query;
    },

    collectPairs(results, marketKeys, markets){
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
    },

};

// The class these methods install onto, read for its statics. The require sits below
// module.exports so the two files load in either order: whichever runs first, the
// other already sees a finished export by the time a method body runs.
const Database = require('../index.js');

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
 * XChain Indexer - orders: the steps of getMarketInfo
 *
 * The reads and folds getMarketInfo in src/db/orders.js runs, in order, as plain functions over
 * the Database instance it passes in. Not a mixin part: nothing here installs onto the prototype.
 * The method keeps its class read, the native-decimals static and the sideOf translation, and
 * hands them in, so this file never requires db/index.js and cannot change its load order.
 *
 ********************************************************************/

// The zeroed market summary every lookup below fills in.
function emptyMarketData(){
    return {
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
}

// The market row itself: its two sides, their decimals and their coins.
async function readMarketRow(db, Database, data, market_id, sideOf){
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
    let results = await db.doQuery(query, args);
    if(results.length > 0){
        let row = results[0];
        // Convert the ids from BIGINT to Number
        row.market_id = Number(row.market_id);
        row.tick1_id  = Number(row.tick1_id);
        row.tick2_id  = Number(row.tick2_id);
        row.coin1_id  = Number(row.coin1_id) || 0;
        row.coin2_id  = Number(row.coin2_id) || 0;
        Object.assign(data, row);
        await backfillMarketCoins(db, data, sideOf);
    }
}

// The ageing sweep (getStaleMarkets) never goes through createMarket, so a
// pair that stopped trading before the coin columns existed has no other way
// back to a labelled row. Derive the two coins from the pair's own earliest
// order, oriented to the way the row stores its sides; updateMarketInfo
// persists them. Guarded on the 0, so a labelled row costs no extra query.
async function backfillMarketCoins(db, data, sideOf){
    if(data.coin1_id===0 || data.coin2_id===0){
        let coins = await db.doQuery(
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

// The last valid trade on the pair.
async function readLastTradePrices(db, data, sideOf){
    // Lookup last trade prices
    let query = `SELECT
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
    let args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid'];
    let results = await db.doQuery(query, args);
    if(results.length > 0){
        let row = results[0];
        let give_amount = (sideOf(row.give_tick_id)===data.tick1_id) ? row.give_amount : row.get_amount;
        let get_amount  = (sideOf(row.give_tick_id)===data.tick1_id) ? row.get_amount  : row.give_amount;
        data.tick1_price = db.util.getPrice(get_amount, give_amount);
        data.tick2_price = db.util.getPrice(give_amount, get_amount);
    }
}

// The last valid trade at or before 24 hours ago.
async function readDayAgoPrices(db, data, time_24hr, sideOf){
    // Lookup trade prices 24-hours ago
    let query = `SELECT
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
    let args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', time_24hr];
    let results = await db.doQuery(query, args);
    if(results.length > 0){
        let row = results[0];
        let give_amount = (sideOf(row.give_tick_id)===data.tick1_id) ? row.give_amount : row.get_amount;
        let get_amount  = (sideOf(row.give_tick_id)===data.tick1_id) ? row.get_amount  : row.give_amount;
        data.tick1_24hr_price = db.util.getPrice(get_amount, give_amount);
        data.tick2_24hr_price = db.util.getPrice(give_amount, get_amount);
    }
}

// The best bid across the pair's open orders.
async function readBestBids(db, data, sideOf){
    // Lookup 'bid' prices
    let query = `SELECT
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
    let args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', 'open'];
    let results = await db.doQuery(query, args);
    if(results.length > 0){
        let tick1_bid = 0,
            tick2_bid = 0;
        for(let row of results){
            let give_amount = (sideOf(row.give_tick_id)===data.tick1_id) ? row.give_amount : row.get_amount;
            let get_amount  = (sideOf(row.give_tick_id)===data.tick1_id) ? row.get_amount : row.give_amount;
            let price1      = db.util.getPrice(get_amount, give_amount);
            let price2      = db.util.getPrice(give_amount, get_amount);
            if(price1==0||price2==0)
                continue;
            if(tick1_bid==0) tick1_bid = price1;
            if(tick2_bid==0) tick2_bid = price2;
            // bcgt, not `>`: getPrice returns a decimal.js bignumber, and a native
            // relational compare between two of them coerces both to strings and ranks
            // them LEXICOGRAPHICALLY, so '10' sorts below '9'. Same disagreement the SQL
            // side flag-dayed in dispenser_send_amount_compare_activation.js.
            if(db.util.bcgt(price1, tick1_bid)) tick1_bid = price1;
            if(db.util.bcgt(price2, tick2_bid)) tick2_bid = price2;
        }
        data.tick1_bid  = tick1_bid;
        data.tick2_bid  = tick2_bid;
    }
}

// The best ask across the pair's open orders.
async function readBestAsks(db, data, sideOf){
    // Lookup 'ask' prices
    let query = `SELECT
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
    let args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', 'open'];
    let results = await db.doQuery(query, args);
    if(results.length > 0){
        let tick1_ask = 0,
            tick2_ask = 0;
        for(let row of results){
            let give_amount = (sideOf(row.give_tick_id)===data.tick1_id) ? row.give_amount : row.get_amount;
            let get_amount  = (sideOf(row.give_tick_id)===data.tick1_id) ? row.get_amount : row.give_amount;
            let price1      = db.util.getPrice(get_amount, give_amount);
            let price2      = db.util.getPrice(give_amount, get_amount);
            if(price1==0||price2==0)
                continue;
            if(tick1_ask==0) tick1_ask = price1;
            if(tick2_ask==0) tick2_ask = price2;
            // bclt for the same reason as the bid block above: a lexicographic rank picks
            // the wrong extreme here, which publishes an understated ask.
            if(db.util.bclt(price1, tick1_ask)) tick1_ask = price1;
            if(db.util.bclt(price2, tick2_ask)) tick2_ask = price2;
        }
        data.tick1_ask = tick1_ask;
        data.tick2_ask = tick2_ask;
    }
}

// The last 24 hours of valid trades on the pair, folded into highs, lows and volumes.
async function readDayStats(db, data, time_24hr, sideOf){
    // Lookup all order matches in the last 24-hours
    let query = `SELECT
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
    let args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', time_24hr];
    let results = await db.doQuery(query, args);
    if(results.length > 0){
        accumulateDayStats(db, data, results, sideOf);
    }
}

// Fold the 24-hour trades into each side's high, low and volume.
function accumulateDayStats(db, data, results, sideOf){
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
        let price1      = db.util.getPrice(get_amount, give_amount);
        let price2      = db.util.getPrice(give_amount, get_amount);
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
        if(db.util.bcgt(price1, tick1_high)) tick1_high = price1;
        if(db.util.bcgt(price2, tick2_high)) tick2_high = price2;
        // 24-hour low
        if(db.util.bclt(price1, tick1_low)) tick1_low = price1;
        if(db.util.bclt(price2, tick2_low)) tick2_low = price2;
        // 24-hour volumes, summed at each tick's own scale. bcadd with the decimals
        // argument omitted formats at precision 0, which quantizes every partial sum
        // to a whole unit: a market of sub-unit fills accumulated to 0.
        tick1_volume = db.util.bcadd(tick1_volume, give_amount, tick1_decimals);
        tick2_volume = db.util.bcadd(tick2_volume, get_amount, tick2_decimals);
    }
    data.tick1_24hr_high   = tick1_high;
    data.tick1_24hr_low    = tick1_low;
    data.tick1_24hr_volume = tick1_volume;
    data.tick2_24hr_high   = tick2_high;
    data.tick2_24hr_low    = tick2_low;
    data.tick2_24hr_volume = tick2_volume;
}

// The 24-hour percentage change of each side's price.
function applyDayChanges(db, data){
    // Calculate 24-hour price change percentage
    let tick1_change = 0.00;
    let tick2_change = 0.00;
    if(db.util.bcgt(data.tick1_price, 0) && db.util.bcgt(data.tick1_24hr_price, 0))
        tick1_change = db.util.bcmul(db.util.bcdiv(db.util.bcsub(data.tick1_price, data.tick1_24hr_price,8), data.tick1_24hr_price,8), 100, 2);
    if(db.util.bcgt(data.tick2_price, 0) && db.util.bcgt(data.tick2_24hr_price, 0))
        tick2_change = db.util.bcmul(db.util.bcdiv(db.util.bcsub(data.tick2_price, data.tick2_24hr_price,8), data.tick2_24hr_price,8), 100, 2);
    data.tick1_24hr_change = tick1_change;
    data.tick2_24hr_change = tick2_change;
}

module.exports = {
    emptyMarketData,
    readMarketRow,
    readLastTradePrices,
    readDayAgoPrices,
    readBestBids,
    readBestAsks,
    readDayStats,
    applyDayChanges,
};

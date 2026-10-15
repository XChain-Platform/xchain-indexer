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
// The markets mixin is cut into parts by behaviour under markets/; this entry merges them
// back into the one method set db/index.js installs, at the position those methods held here.
const marketPairs = require('./market_pairs.js');

module.exports = {

    ...marketPairs,

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

    // The markets the per-block 24h ageing sweep (processMarketUpdates) refreshes, in two parts.
    // First a batch of the most-stale rows, last refreshed before `time_24hr` (NULL = never),
    // oldest-first and capped at `limit`: ORDER BY (last_updated, id) is stable. Then, when the
    // caller passes the block, every market getAgedMarkets finds, uncapped, because its stored 24h
    // figures are already wrong at this block; that read costs O(matches leaving the window this
    // block), not O(history). The `markets` table is unhashed / snapshot-replicated with no
    // consensus reader (see rollback.js IDX-2), so a node-local sweep cadence cannot diverge state.
    async getStaleMarkets(time_24hr, limit, block_index){
        let max = Number(limit);
        if(!Number.isFinite(max) || max <= 0) max = 25;
        let rows = await this.doQuery(
            `SELECT id
             FROM markets
             WHERE last_updated IS NULL OR last_updated < ?
             ORDER BY (last_updated IS NULL) DESC, last_updated ASC, id ASC
             LIMIT ?`,
            [time_24hr, max]);
        rows = rows || [];
        if(block_index === undefined || block_index === null) return rows;
        let seen = new Set(rows.map(row => Number(row.id)));
        for(let row of await this.getAgedMarkets(block_index, time_24hr))
            if(!seen.has(Number(row.id))) rows.push(row);
        return rows;
    },

    // The rollback's market pairs plus every market whose last_updated is past block_time, the
    // surviving tip's time, so stamped by a block the reorg removed: the 24h ageing sweep
    // refreshes a market no orphaned order row names. Pairs keep their order; the extra
    // markets follow by id, each once in either orientation.
    async withMarketsRefreshedAfter(markets, block_time){
        if(!Number.isFinite(Number(block_time)))
            return markets;
        let key  = (p) => Math.min(Number(p.tick1_id), Number(p.tick2_id)) + ':' + Math.max(Number(p.tick1_id), Number(p.tick2_id));
        let seen = new Set(markets.map(key));
        let rows = await this.doQuery(
            `SELECT tick1_id, tick2_id, coin1_id, coin2_id FROM markets WHERE last_updated > ? ORDER BY id ASC`,
            [Number(block_time)]);
        let out = markets.slice();
        for(let row of (rows || [])){
            if(seen.has(key(row))) continue;
            seen.add(key(row));
            out.push({ tick1_id: Number(row.tick1_id), tick2_id: Number(row.tick2_id),
                       coin1_id: Number(row.coin1_id) || 0, coin2_id: Number(row.coin2_id) || 0 });
        }
        return out;
    },

    // Markets whose 24h figures changed only because time moved: a valid same-coin match whose
    // block_time lies between the previous block's window start and this block's (time_24hr) has
    // just left the window, so the stored 24h price, high, low, volume and change no longer match
    // a recompute. Both ends are bounded: the slice is found by block_index (indexed) with a
    // binary search over block times whose targets sit AGED_SLICE_WIDEN_SECONDS outside the
    // window edges, for stamps that run out of height order, and only that slice's actions are
    // read; the exact block_time filter then keeps the true slice. A market already
    // refreshed at this block (last_updated = time_24hr + 24h) is left out.
    async getAgedMarkets(block_index, time_24hr){
        let height = Number(block_index), cutoff = Number(time_24hr);
        if(!Number.isFinite(height) || !Number.isFinite(cutoff)) return [];
        let previous = await this.protocolTimeForStoredBlock(height - 1);
        if(previous === false || previous === null || !Number.isFinite(Number(previous))) return [];
        let from = Number(previous) - 86400;
        if(from > cutoff) return [];
        let bottom = await this.doQuery('SELECT MIN(block_index) AS b FROM blocks', []);
        let low    = (bottom && bottom.length > 0 && bottom[0].b !== null) ? Number(bottom[0].b) : height;
        let first  = await firstBlockAtOrAfter(this, from - AGED_SLICE_WIDEN_SECONDS, low, height);
        let last   = await firstBlockAtOrAfter(this, cutoff + AGED_SLICE_WIDEN_SECONDS + 1, first, height) - 1;
        // The status is compared in JS, not joined by name: a status join hands the planner an
        // equality that drives the read from every valid match instead of the block slice.
        let validId = await this.getStatusId('valid');
        let pairs   = await this.doQuery(
            `SELECT DISTINCT
                    COALESCE(om.give_tick_id,0) AS give_tick_id,
                    COALESCE(om.get_tick_id,0)  AS get_tick_id,
                    om.status_id                AS status_id
             FROM actions a
                INNER JOIN order_matches om ON (om.action_index=a.action_index)
                INNER JOIN blocks        b  ON (b.block_index=a.block_index)
             WHERE a.block_index BETWEEN ? AND ? AND
                   om.give_coin_id=om.get_coin_id AND
                   b.block_time >= ? AND
                   b.block_time <= ?`,
            [first, Math.min(height, last), from, cutoff]);
        let ids = new Set();
        for(let pair of (pairs || []).filter(row => validId !== null && Number(row.status_id) === Number(validId))){
            let row = await this.getMarketRow(pair.give_tick_id, pair.get_tick_id);
            if(row) ids.add(Number(row.id));
        }
        if(ids.size === 0) return [];
        let list = [...ids];
        let rows = await this.doQuery(
            `SELECT id FROM markets
             WHERE id IN (${list.map(() => '?').join(', ')}) AND (last_updated IS NULL OR last_updated < ?)
             ORDER BY id ASC`,
            [...list, cutoff + 86400]);
        return rows || [];
    },

};

// Seconds a time-sliced read moves each binary-search target outward. A block's stamp must exceed
// the median of the 11 before it and may run up to 2 hours ahead of network time, so a block
// stamped 7200 s ahead sits above every block mined in the next 2 hours: about 18 blocks on BTC,
// 54 on LTC and 126 on DOGE. A block count cannot cover all three chains; 3 hours of time does,
// with an hour of margin, on every chain.
const AGED_SLICE_WIDEN_SECONDS = 10800;

// The lowest height in [lo, hi] whose stored block_time is at or after `time`, by binary search,
// reading as if stamps rose with height (the widening above covers the ones that do not). A height
// with no blocks row reads as earlier. hi when none qualifies.
async function firstBlockAtOrAfter(db, time, lo, hi){
    while(lo < hi){
        let mid = Math.floor((lo + hi) / 2);
        let t   = await db.getBlockTimeAtHeightOrNull(mid);
        if(t === null || t < time) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// The class these methods install onto, read for its statics. The require sits below
// module.exports so the two files load in either order: whichever runs first, the
// other already sees a finished export by the time a method body runs.
const Database = require('../index.js');

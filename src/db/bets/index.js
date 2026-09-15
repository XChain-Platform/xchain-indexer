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
 * XChain Indexer - Database mixin: bets
 * 
 * The queries over the bets table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// The bets mixin is cut into parts by behaviour under bets/; this entry merges them
// back into the one method set db/index.js installs, at the position those methods held here.
const records  = require('./records.js');
const listings = require('./listings.js');

module.exports = {

    // Return order info for given action_index
    // Resolve a single order by its (locally-unique) action_index. `coin` matches the
    // order's GET coin: for a SAME-chain order get_coin == the local coin, and for a
    // CROSS-chain order get_coin == the counterparty coin. Pass the counterparty coin
    // (e.g. cross_settle) to assert the get side, or pass null to look up purely by
    // action_index - which is what cancel/expire/edit must do, since those operate on a
    // local order by index and cannot assume its get_coin is local (that assumption is
    // exactly what hid cross-chain offers from the cancel/expire paths).
    /*
     * BET parimutuel betting
     */

    ...records,

    // Return information on a bet feed for the given action_index
    async getBetFeedInfo(action_index){
        let feed  = false;
        let query = `SELECT
                        f.action_index,
                        f.label,
                        f.outcomes,
                        t1.tick,
                        f.fee,
                        f.deadline,
                        f.refund_window,
                        f.expire_at,
                        f.min_amount,
                        f.allow_list,
                        f.block_list,
                        f.details,
                        m1.memo,
                        s1.status,
                        s2.status as feed_status,
                        f.closed_block,
                        f.terminal_block,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time
                    FROM
                        bet_feeds f
                        INNER JOIN actions         a1 ON (a1.action_index=f.action_index)
                        INNER JOIN transactions    tx ON (tx.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=tx.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        LEFT  JOIN index_tickers   t1 ON (t1.id=f.tick_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=f.memo_id)
                        INNER JOIN index_statuses  s1 ON (s1.id=f.status_id)
                        INNER JOIN index_statuses  s2 ON (s2.id=f.feed_status_id)
                    WHERE
                        f.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0){
            feed = {};
            for(let key in results[0]){
                let name  = String(key).toUpperCase();
                let value = results[0][key];
                // Convert numerics but PRESERVE NULL: Number(null) is 0, and a
                // NULL allow_list collapsing to 0 would make every ungated feed
                // read as gated by the (nonexistent) list at action_index 0,
                // rejecting all bets. Amount-ish fields (fee/min_amount) stay
                // strings for bignumber math
                if(!this.util.isNull(value) && ['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'DEADLINE', 'REFUND_WINDOW', 'EXPIRE_AT', 'ALLOW_LIST', 'BLOCK_LIST', 'CLOSED_BLOCK', 'TERMINAL_BLOCK'].includes(name))
                    value = Number(value);
                feed[name] = value;
            }
        }
        return feed;
    },

    // Return the `open` bets on a feed, action_index ASC (the normative
    // settlement/refund selection: spec section 7 pool predicate)
    async getOpenBetsByFeed(feed_action_index){
        let open_id = await this.createStatus('open');
        let query = `SELECT
                        b.action_index,
                        b.outcome,
                        b.amount,
                        a2.address as source
                    FROM
                        bets b
                        INNER JOIN actions         a1 ON (a1.action_index=b.action_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                    WHERE
                        b.feed_action_index=? AND
                        b.bet_status_id=?
                    ORDER BY b.action_index ASC`;
        let results = await this.doQuery(query, [feed_action_index, open_id]);
        let bets = [];
        for(let row of results){
            bets.push({
                'ACTION_INDEX': Number(row.action_index),
                'OUTCOME':      Number(row.outcome),
                'AMOUNT':       row.amount,
                'SOURCE':       row.source
            });
        }
        return bets;
    },

    // Count the `open` bets on a feed (MAX_BETS_PER_FEED bound at place time)
    async countOpenBetsByFeed(feed_action_index){
        let open_id = await this.createStatus('open');
        let query   = `SELECT COUNT(*) as cnt FROM bets WHERE feed_action_index=? AND bet_status_id=?`;
        let results = await this.doQuery(query, [feed_action_index, open_id]);
        return (results.length > 0) ? Number(results[0].cnt) : 0;
    },

    // Latch a feed `closed` (end-of-block pass step 1). Idempotence-guarded in
    // the WHERE: only an `open`, never-latched feed takes the write, so a
    // crash-restart replay of the block cannot latch twice or overwrite the
    // original latch block. One `closed` transition per feed lifetime, one-way
    async latchBetFeedClosed(feed_action_index, block_index){
        let open_id   = await this.createStatus('open');
        let closed_id = await this.createStatus('closed');
        let query = `UPDATE
                        bet_feeds
                    SET
                        feed_status_id=?,
                        closed_block=?
                    WHERE
                        action_index=? AND
                        feed_status_id=? AND
                        closed_block IS NULL`;
        await this.doQuery(query, [closed_id, block_index, feed_action_index, open_id]);
    },

    // Move a feed to a terminal status (resolved / resolved_void / cancelled /
    // expired), stamping terminal_block in the same write. The stamp keys the
    // reorg reset, the state-hash class, and the sync updated_rows forward
    // class (in-place mutation on a surviving row, polls.resolved_block pattern)
    async setBetFeedTerminal(feed_action_index, status, block_index){
        let status_id = await this.createStatus(status);
        let query = `UPDATE
                        bet_feeds
                    SET
                        feed_status_id=?,
                        terminal_block=?
                    WHERE
                        action_index=?`;
        await this.doQuery(query, [status_id, block_index, feed_action_index]);
    },

    // Move a bet to a terminal status (won / lost / refunded), stamping
    // settled_block in the same write (same stamp discipline as above)
    async setBetSettled(bet_action_index, status, block_index){
        let status_id = await this.createStatus(status);
        let query = `UPDATE
                        bets
                    SET
                        bet_status_id=?,
                        settled_block=?
                    WHERE
                        action_index=?`;
        await this.doQuery(query, [status_id, block_index, bet_action_index]);
    },

    ...listings,

    // Feeds due to latch: `open` with DEADLINE reached, deadline ASC then
    // action_index ASC (the deterministic pass order), capped per block
    async getBetFeedsDueLatch(block_time, limit){
        let open_id = await this.createStatus('open');
        let query = `SELECT
                        f.action_index
                    FROM
                        bet_feeds f
                    WHERE
                        f.feed_status_id=? AND
                        f.deadline <= ?
                    ORDER BY f.deadline ASC, f.action_index ASC
                    LIMIT ${parseInt(limit)}`;
        return await this.doQuery(query, [open_id, block_time]);
    },

    // Feeds due to expire: `open`/`closed` with expire_at reached, expire_at ASC
    // then action_index ASC, capped per block by feed count; each row carries its
    // `open`-bet count so the pass can also enforce the refund-credit budget
    async getBetFeedsDueExpiry(block_time, limit){
        let open_id   = await this.createStatus('open');
        let closed_id = await this.createStatus('closed');
        let query = `SELECT
                        f.action_index,
                        f.expire_at,
                        (SELECT COUNT(*) FROM bets b WHERE b.feed_action_index=f.action_index AND b.bet_status_id=?) as open_bets
                    FROM
                        bet_feeds f
                    WHERE
                        f.feed_status_id IN (?, ?) AND
                        f.expire_at <= ?
                    ORDER BY f.expire_at ASC, f.action_index ASC
                    LIMIT ${parseInt(limit)}`;
        return await this.doQuery(query, [open_id, open_id, closed_id, block_time]);
    },

};

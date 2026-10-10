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
 * XChain Indexer - Database mixin part: bets / listings
 *
 * The paged JSON-RPC read surface over bet_feeds and bets, and the per-outcome pool
 * sums of one feed.
 * Merged into the bets mixin by db/bets/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const BET_FEED_ROWS_QUERY = `SELECT
                                f.action_index,
                                f.label,
                                f.outcomes,
                                t1.tick,
                                f.fee,
                                f.deadline,
                                f.refund_window,
                                f.expire_at,
                                f.min_amount,
                                CASE
                                    WHEN ae.action_index IS NULL THEN f.allow_list
                                    ELSE NULLIF(ae.allow_list, 0)
                                END as allow_list,
                                CASE
                                    WHEN be.action_index IS NULL THEN f.block_list
                                    ELSE NULLIF(be.block_list, 0)
                                END as block_list,
                                m1.memo,
                                s2.status as feed_status,
                                f.closed_block,
                                f.terminal_block,
                                a2.address as source,
                                b1.block_index
                            FROM
                                bet_feeds f
                                INNER JOIN actions         a1 ON (a1.action_index=f.action_index)
                                INNER JOIN transactions    tx ON (tx.tx_index=a1.tx_index)
                                LEFT  JOIN blocks          b1 ON (b1.block_index=tx.block_index)
                                INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                                LEFT  JOIN index_tickers   t1 ON (t1.id=f.tick_id)
                                LEFT  JOIN index_memos     m1 ON (m1.id=f.memo_id)
                                INNER JOIN index_statuses  s2 ON (s2.id=f.feed_status_id)
                                LEFT  JOIN bet_edits ae ON (
                                    ae.action_index=(
                                        SELECT MAX(e.action_index)
                                        FROM bet_edits e
                                        INNER JOIN index_statuses es ON (es.id=e.status_id)
                                        WHERE
                                            e.feed_action_index=f.action_index AND
                                            es.status='valid' AND
                                            e.allow_list IS NOT NULL
                                    )
                                )
                                LEFT  JOIN bet_edits be ON (
                                    be.action_index=(
                                        SELECT MAX(e.action_index)
                                        FROM bet_edits e
                                        INNER JOIN index_statuses es ON (es.id=e.status_id)
                                        WHERE
                                            e.feed_action_index=f.action_index AND
                                            es.status='valid' AND
                                            e.block_list IS NOT NULL
                                    )
                                )
                            WHERE
                                1=1`;

function betFeedRowFilters(db, opts){
    let sql  = '';
    const args = [];
    if(!db.util.isNull(opts.status)){
        sql += ' AND s2.status=?';
        args.push(String(opts.status));
    }
    if(!db.util.isNull(opts.source)){
        sql += ' AND a2.address=?';
        args.push(String(opts.source));
    }
    if(!db.util.isNull(opts.tick)){
        sql += ' AND t1.tick=?';
        args.push(String(opts.tick));
    }
    if(!db.util.isNull(opts.after_action_index) && db.util.isNumeric(opts.after_action_index)){
        sql += ' AND f.action_index > ?';
        args.push(parseInt(opts.after_action_index));
    }
    return { sql, args };
}

module.exports = {

    // Paged bet-feed listing for the JSON-RPC read surface (ops tooling / e2e;
    // the PUBLIC api is the explorer REST layer, which queries this DB directly).
    // Filters: feed status / oracle (source) address / wager tick; keyset paging
    // on action_index ASC
    async getBetFeedRows(opts = {}){
        let limit = parseInt(opts.limit);
        if(!Number.isFinite(limit) || limit <= 0) limit = 100;
        const { sql, args } = betFeedRowFilters(this, opts);
        const query = BET_FEED_ROWS_QUERY + sql + `
                    ORDER BY f.action_index ASC
                    LIMIT ${limit}`;
        return await this.doQuery(query, args);
    },

    // Per-outcome pool sums for one feed (open bets only, the settlement
    // predicate). Sums as strings (CAST to CHAR) so the driver never coerces
    // through a float
    async getBetFeedPools(feed_action_index){
        let open_id = await this.createStatus('open');
        let query = `SELECT
                        b.outcome,
                        CAST(SUM(CAST(b.amount AS DECIMAL(60,18))) AS CHAR) as pool,
                        COUNT(*) as bets
                    FROM
                        bets b
                    WHERE
                        b.feed_action_index=? AND
                        b.bet_status_id=?
                    GROUP BY b.outcome
                    ORDER BY b.outcome ASC`;
        return await this.doQuery(query, [feed_action_index, open_id]);
    },

    // Paged bet listing for the JSON-RPC read surface. Filters: feed / bettor
    // address / bet status; keyset paging on action_index ASC
    async getBetRows(opts = {}){
        let limit = parseInt(opts.limit);
        if(!Number.isFinite(limit) || limit <= 0) limit = 100;
        let sql  = '';
        let args = [];
        if(!this.util.isNull(opts.feed) && this.util.isNumeric(opts.feed)){
            sql += ' AND b.feed_action_index=?';
            args.push(parseInt(opts.feed));
        }
        if(!this.util.isNull(opts.source)){
            sql += ' AND a2.address=?';
            args.push(String(opts.source));
        }
        if(!this.util.isNull(opts.status)){
            sql += ' AND s2.status=?';
            args.push(String(opts.status));
        }
        if(!this.util.isNull(opts.after_action_index) && this.util.isNumeric(opts.after_action_index)){
            sql += ' AND b.action_index > ?';
            args.push(parseInt(opts.after_action_index));
        }
        let query = `SELECT
                        b.action_index,
                        b.feed_action_index,
                        b.outcome,
                        t1.tick,
                        b.amount,
                        s2.status as bet_status,
                        b.settled_block,
                        a2.address as source,
                        bl.block_index
                    FROM
                        bets b
                        INNER JOIN actions         a1 ON (a1.action_index=b.action_index)
                        INNER JOIN transactions    tx ON (tx.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          bl ON (bl.block_index=tx.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        LEFT  JOIN index_tickers   t1 ON (t1.id=b.tick_id)
                        INNER JOIN index_statuses  s2 ON (s2.id=b.bet_status_id)
                    WHERE
                        1=1` + sql + `
                    ORDER BY b.action_index ASC
                    LIMIT ${limit}`;
        return await this.doQuery(query, args);
    },

};

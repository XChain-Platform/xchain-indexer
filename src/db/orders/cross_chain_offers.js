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
 * XChain Indexer - Database mixin part: orders (cross-chain offers)
 *
 * The open cross-chain offer book the xchain-hub federation matches against (XCC-2).
 * A part of the orders mixin: src/db/orders/index.js merges it into the one method set that
 * db/index.js installs onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// The per-kind WHERE terms and their bound values, one list per UNION ALL branch, in the
// order the branches bind them.
function offerFilters(db, after_action_index, to_coin){
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
    let hasCursor = !db.util.isNull(after_action_index) && Number.isFinite(Number(after_action_index));
    if(!db.util.isNull(to_coin)){ swapWhere.push(`cc.coin=?`);  swapArgs.push(to_coin); }
    if(hasCursor){ swapWhere.push(`s1.action_index>?`); swapArgs.push(Number(after_action_index)); }
    if(!db.util.isNull(to_coin)){ orderWhere.push(`cc.coin=?`); orderArgs.push(to_coin); }
    if(hasCursor){ orderWhere.push(`o1.action_index>?`); orderArgs.push(Number(after_action_index)); }
    return { swapArgs, orderArgs, swapWhere, orderWhere };
}

// The SWAP branch of the offer book, over the WHERE terms offerFilters built.
function swapBranchSql(swapWhere){
    return `SELECT
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
}

// The ORDER branch of the offer book, column for column the SWAP branch's list.
function orderBranchSql(orderWhere){
    return `SELECT
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
}

// One merged book row as the offer object the hub reads.
function offerFromRow(db, row){
    let isOwnGive = (Number(row.give_ownership) === 1 && db.util.isNull(row.give_amount));
    let isOwnGet  = (Number(row.get_ownership)  === 1 && db.util.isNull(row.get_amount));
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
    return offer;
}

module.exports = {

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
        let { swapArgs, orderArgs, swapWhere, orderWhere } = offerFilters(this, after_action_index, to_coin);
        let swapBranch  = swapBranchSql(swapWhere);
        let orderBranch = orderBranchSql(orderWhere);
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
            let offer = offerFromRow(this, row);
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

};

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
 * XChain Indexer - Database mixin part: index_tables / expired_items
 *
 * The per-block sweep that lists the open orders, swaps and dispensers whose effective
 * expiration has passed.
 * Merged into the index_tables mixin by db/index_tables/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Lookup items that need to be expired and return a list
    //
    // The expiration cut is applied IN SQL rather than by pulling the ENTIRE
    // open order/swap/dispenser book back to the client every block, resolving the
    // edits overlay with a second batched query per type, and only then applying
    // the cutoff in JS: that shape scales per-block row transfer and memory with
    // the whole open book rather than the (usually tiny) set expiring this block.
    // The returned rows, their order, and their values are identical either way.
    //
    // NULL expiration semantics - CONSENSUS-CRITICAL, preserved exactly:
    // all six `expiration` columns (orders/swaps/dispensers and their `_edits`)
    // are nullable. The old JS predicate was `info.expiration < block_time`,
    // where JS coerces a null expiration to 0, so a null effective expiration
    // meant "expired at time 0" and the item expired on the first block that
    // swept it. A naive SQL `eff_expiration < ?` evaluates to NULL for those
    // rows, drops them, and that item would NEVER expire - a silent consensus
    // change. `COALESCE(eff_expiration, 0) < ?` is the byte-equivalent form and
    // is what is used below. Note this deliberately does NOT agree with
    // getOpenCrossChainOffers, which keeps a null-expiration offer as
    // never-expiring; that divergence is pre-existing and out of scope here.
    // In practice a null BASE expiration is unreachable on current code: the
    // ORDER/SWAP/DISPENSER create handlers all fill in util.getDefaultExpiration()
    // when the field is absent. Null EDIT expirations are normal and mean "leave
    // the expiration unchanged".
    //
    // Effective expiration = the last `valid` edit carrying a non-null expiration
    // (highest edit action_index), else the base row's expiration. That is the
    // same rule the old ascending "last non-null wins" JS loop implemented, and
    // the same overlay getOpenCrossChainOffers applies.
    async getExpiredItems(block_time){
        let expired = [];
        let types   = ['order','swap','dispenser'];
        let query   = '';
        let args    = [];
        // A non-numeric block_time made every old JS compare false (`x < undefined`,
        // `x < null` compared against 0), so nothing expired. Return that same answer
        // instead of binding NULL/NaN into SQL, where comparison semantics differ.
        let cutoff = Number(block_time);
        if(this.util.isNull(block_time) || !Number.isFinite(cutoff))
            return expired;
        // Build out the query for each of the table types to get 'open' items whose
        // effective expiration has already passed.
        for(let type of types){
            if(query!='')
                query += 'UNION ';
            query += expiredSql.openExpiredOfType(type);
            args.push(cutoff);
        }
        // Process expirations in ascending global action_index order so every
        // instance derives identical AUTO_INCREMENT IDs for the same block.
        // (UNION result: order by the output column name, not a table alias.)
        query += ' ORDER BY action_index ASC';
        let results = await this.doQuery(query, args);
        for(let info of results){
            expired.push({
                type:         info.type,
                action_index: Number(info.action_index),
                // Number(null) === 0, matching the old null-coerced expiration value.
                expiration:   Number(info.expiration)
            });
        }
        return expired;
    },

};

// One branch of getExpiredItems' UNION, kept off the exported object so Database.prototype
// gains no method: the open items of `type` whose effective expiration is below the bound
// cutoff, carrying that expiration and the type label.
const expiredSql = {

    openExpiredOfType(type){
        // Scalar subquery for the edits overlay: newest `valid` edit that actually
        // set an expiration wins, NULL when the item has no such edit.
        let editExpiration = `(
                            SELECT
                                e1.expiration
                            FROM
                                ` + type + `_edits e1
                                INNER JOIN index_statuses e2 ON (e2.id=e1.status_id)
                            WHERE
                                e1.` + type + `_action_index=m.action_index AND
                                e2.status='valid' AND
                                e1.expiration IS NOT NULL
                            ORDER BY
                                e1.action_index DESC
                            LIMIT 1
                        )`;
        return `SELECT
                        m.action_index,
                        COALESCE(` + editExpiration + `, m.expiration) as expiration,
                        '` + type + `' as type
                    FROM
                        ` + type + `s m
                        INNER JOIN ` + type + `_statuses s1 ON (s1.` + type + `_action_index=m.action_index)
                        INNER JOIN index_statuses        s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                ` + type + `_statuses s3
                            WHERE
                                s3.` + type + `_action_index=m.action_index
                        ) AND
                        s2.status='open' AND
                        COALESCE(` + editExpiration + `, m.expiration, 0) < ? `;
    },

};

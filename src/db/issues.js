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
 * XChain Indexer - Database mixin: issues
 * 
 * The queries over the issues table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// The issues mixin is cut into parts by behaviour under issues/; this entry merges them
// back into the one method set db/index.js installs, at the position those methods held here.
const tokenInfo   = require('./issues/token_info.js');
const issueWriter = require('./issues/issue_writer.js');

module.exports = {

    ...tokenInfo,

    // Handle getting decimal precision for a given tick_id
    async getTokenDecimalPrecision(tick_id){
        let decimals = 0;
        // Lookup decimal precision using the issues table 
        // DO NOT lookup precision using getTokenInfo() (avoid recursive queries)
        let query = `SELECT
                        i.decimals
                    FROM
                        issues i,
                        index_statuses s
                    WHERE
                        i.status_id=s.id AND
                        i.tick_id=? AND
                        s.status='valid'`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0){
            // Loop through ISSUE transactions for the given ticker
            for(let row of results){
                if(!this.util.isNull(row.decimals) && row.decimals > decimals)
                    decimals = row.decimals;
            }
        }
        // Clamp decimals to valid range [0, 18] to prevent SQL injection via DECIMAL CAST
        decimals = Math.max(0, Math.min(18, parseInt(decimals) || 0));
        return decimals;
    },

    ...issueWriter,

    // Return the tick associated with an ISSUE action_index, or null if the
    // action_index does not resolve to a valid ISSUE. Used by LINK to decide
    // whether a linked action is targeting a TICK (and thus subject to the
    // owner / ownership-escrow rules).
    async getIssueTick(action_index){
        let query = `SELECT
                        t.tick
                    FROM
                        issues i
                        INNER JOIN index_tickers t ON (t.id=i.tick_id)
                        INNER JOIN index_statuses s ON (s.id=i.status_id)
                    WHERE
                        i.action_index=? AND
                        s.status='valid'
                    LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            return results[0].tick;
        return null;
    },

    // Get action_index of the first valid ISSUE action for a given ticker
    async getFirstIssueActionIndex(tick){
        let tick_id      = await this.createTicker(tick);
        let action_index = false;
        let query = `SELECT 
                        i.action_index 
                    FROM
                        issues i
                        INNER JOIN index_statuses s ON (s.id=i.status_id)
                    WHERE 
                        i.tick_id=? AND 
                        s.status='valid'
                    ORDER BY 
                        action_index ASC 
                    LIMIT 1`;
        let args = [tick_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            action_index = Number(results[0].action_index);
        return action_index;
    },

};

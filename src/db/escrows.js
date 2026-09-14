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
 * XChain Indexer - Database mixin: escrows
 * 
 * The queries over the escrows table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const ledgerPrecision = require('../ledger_amount_precision_activation');

// The escrow-holding kinds getAddressEscrows lists, in the order it lists them: the
// type tag each row is reported under, and the query for the address's items of that
// kind whose latest status is still 'open'.
const ESCROW_KINDS = [
    // Get list of orders with escrowed tokens
    { type: 'order', query: `SELECT 
                        o1.action_index
                    FROM
                        orders                    o1
                        INNER JOIN order_statuses s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN actions        a1 ON (a1.action_index=o1.action_index)        
                        INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                order_statuses s3
                            WHERE
                                s3.order_action_index=o1.action_index
                        ) AND
                        a1.source_id=? AND
                        s2.status='open'
                    ORDER BY 
                        a1.action_index ASC` },
    // Get list of swaps with escrowed tokens
    { type: 'swap', query: `SELECT 
                    s1.action_index
                FROM
                    swaps                     s1
                    INNER JOIN swap_statuses  s2 ON (s2.swap_action_index=s1.action_index)
                    INNER JOIN actions        a1 ON (a1.action_index=s1.action_index)        
                    INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN index_statuses s3 ON (s3.id=s2.status_id)
                WHERE 
                    s2.action_index = (
                        SELECT
                            MAX(s4.action_index)
                        FROM
                            swap_statuses s4
                        WHERE
                            s4.swap_action_index=s1.action_index
                    ) AND
                    a1.source_id=? AND
                    s3.status='open'
                ORDER BY 
                    a1.action_index ASC` },
    // Get list of dispensers with escrowed tokens
    { type: 'dispenser', query: `SELECT 
                    d1.action_index
                FROM
                    dispensers                    d1
                    INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                    INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)        
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                WHERE 
                    s1.action_index = (
                        SELECT
                            MAX(s3.action_index)
                        FROM
                            dispenser_statuses s3
                        WHERE
                            s3.dispenser_action_index=d1.action_index
                    ) AND
                    a1.source_id=? AND
                    s2.status='open'
                ORDER BY 
                    a1.action_index ASC` },
];

module.exports = {

    // Get escrowed token supply for a given ticker from escrows table
    async getTokenSupplyEscrow(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        // Exact-scale sum, rounded once at the tick's scale; same reason as
        // getTokenSupplyBalance above, and the same shape sanityCheck's escrow-total
        // projection uses.
        let query = `SELECT ` + ledgerPrecision.exactSumSql('amount') + ` as supply FROM escrows WHERE tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [tick_id]);
        // bcstr for the same reason as getTokenSupplyBalance above.
        if(results.length > 0 && !this.util.isNull(results[0].supply))
            supply = this.util.bcstr(this.util.bcadd(results[0].supply, 0, decimals));
        return supply;
    },

    // Get escrowed tokens for a given address
    async getAddressEscrows(address, block_index, action_index){
        let id      = await this.createAddress(address);
        let escrows = [];
        let args    = [id];
        // One query per kind in ESCROW_KINDS order, each row tagged with its kind.
        for(const kind of ESCROW_KINDS){
            let results = await this.doQuery(kind.query, args);
            if(results.length > 0){
                for(let row of results)
                    escrows.push({
                        type: kind.type,
                        action_index: Number(row.action_index)
                    });
            }
        }
        return escrows;
    },

};

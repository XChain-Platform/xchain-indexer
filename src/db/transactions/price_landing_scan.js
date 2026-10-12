/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Indexer - Database mixin part: transactions (price landing scan)
 *
 * The read of the first PRICE action above a block in the xchain-decoder database.
 * A part of the transactions mixin: src/db/transactions/index.js merges it into the one
 * method set that db/index.js installs onto Database.prototype.
 *
 ********************************************************************/

const { isPriceRow } = require('../../chain/price_landing_clear.js');

const PAGE = 200;

// A coarse text prefilter in SQL; isPriceRow makes the final call on each candidate.
// Rows with a NULL payload are candidates too, since isPriceRow cannot rule them out.
const CANDIDATE_SQL = `SELECT block_index, data
                         FROM transactions
                        WHERE block_index > ? AND block_index <= ?
                          AND (data IS NULL OR LOWER(data) LIKE '%price%')
                        ORDER BY block_index ASC, tx_index ASC
                        LIMIT ${PAGE} OFFSET ?`;

module.exports = {

    // The lowest block in (afterBlock, upToBlock] holding a PRICE row, or null when there is none.
    // Strict read so a transient fault throws rather than reading as "no PRICE action".
    async getFirstPriceBlockAfter(afterBlock, upToBlock){
        let after  = Number(afterBlock);
        let limit  = Number(upToBlock);
        for(let offset = 0; after < limit; offset += PAGE){
            let rows = await this.doQueryStrict(CANDIDATE_SQL, [after, limit, offset]);
            for(let row of rows)
                if(isPriceRow(row)) return Number(row.block_index);
            if(rows.length < PAGE) return null;
        }
        return null;
    },

};

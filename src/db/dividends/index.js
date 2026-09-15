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
 * XChain Indexer - Database mixin: dividends
 * 
 * The queries over the dividends table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `dividends` table
    async createDividend(data){
        data                 = this.normalizeDataValues(data);
        let tick_id          = await this.createTicker(data['TICK']);
        let dividend_tick_id = await this.createTicker(data['DIVIDEND_TICK']);
        let memo_id          = await this.createMemo(data['MEMO']);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let amount           = data['AMOUNT'];
        // Check if record already exists for this dividend
        let query  = `SELECT
                            action_index
                        FROM
                            dividends
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dividends
                    SET
                        tick_id=?,
                        dividend_tick_id=?,
                        amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;

        } else {
            // INSERT record
            query = `INSERT INTO dividends (tick_id, dividend_tick_id, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [tick_id, dividend_tick_id, amount, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

};

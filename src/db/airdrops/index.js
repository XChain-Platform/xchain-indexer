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
 * XChain Indexer - Database mixin: airdrops
 * 
 * The queries over the airdrops table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `airdrops` table
    async createAirdrop(data){
        data                  = this.normalizeDataValues(data);
        let tick_id           = await this.createTicker(data['TICK']);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let amount            = data['AMOUNT'];
        let list_action_index = (!this.util.isNumeric(data['LIST_ACTION_INDEX'])) ? null : data['LIST_ACTION_INDEX'];
        // Check if record already exists for this airdrop
        let query = `SELECT
                        action_index
                    FROM
                        airdrops
                    WHERE
                        tick_id=? AND
                        memo_id=? AND
                        list_action_index=? AND
                        amount=? AND
                        action_index=?`;
        let args  = [tick_id, memo_id, list_action_index, amount, action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // Define list of arguments for sql insert/update
        if(exists){
            // UPDATE record
            query = `UPDATE
                        airdrops
                    SET
                        tick_id=?,
                        list_action_index=?,
                        amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO airdrops (tick_id, list_action_index, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [tick_id, list_action_index, amount, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

};

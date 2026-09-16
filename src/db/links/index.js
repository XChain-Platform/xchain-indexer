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
 * XChain Indexer - Database mixin: links
 * 
 * The queries over the links table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `links` table
    async createLink(data){
        data                   = this.normalizeDataValues(data);
        let coin1_id           = await this.createCoin(data['COIN1']);
        let coin2_id           = await this.createCoin(data['COIN2']);
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        let action_index       = data['ACTION_INDEX'];
        let coin1_action_index = data['COIN1_ACTION_INDEX'];
        let coin2_action_index = data['COIN2_ACTION_INDEX'];
        // Check if record already exists for this link
        let query  = `SELECT
                            action_index
                        FROM
                            links
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
                        links
                    SET
                        coin1_id=?,
                        coin1_action_index=?,
                        coin2_id=?,
                        coin2_action_index=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO links (coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

};

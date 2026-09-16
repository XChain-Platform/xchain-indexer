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
 * XChain Indexer - Database mixin: batches
 * 
 * The queries over the batches table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create record in `batches` table
    async createBatch(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        // Check if record already exists for this address
        let query = "SELECT action_index FROM batches WHERE action_index=? LIMIT 1";
        let args  = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE
                        batches
                    SET
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            query = "INSERT INTO batches (status_id, action_index) values (?, ?)";
        }
        args    = [status_id, action_index];
        results = await this.doQuery(query, args);
    },

};

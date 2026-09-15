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
 * XChain Indexer - Database mixin: deposits
 * 
 * The queries over the deposits table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create record in `deposits` table
    async createDeposit(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let tick_id      = await this.createTicker(data['TICK']);
        let action_index = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_ACTION_INDEX'];
        let amount       = data['AMOUNT'];
        let block_index  = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM deposits WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE deposits SET
                        contract_index=?, source_id=?, tick_id=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [contract_index, source_id, tick_id, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO deposits
                        (contract_index, source_id, tick_id, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
            args = [contract_index, source_id, tick_id, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    },

};

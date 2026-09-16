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
 * XChain Indexer - Database mixin: slashes
 * 
 * The queries over the slashes table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Record a slash event row. Caller has already deducted from contract_stakes/contract_unstakes
    // (via slashContractStake) and credited the destination address.
    async createSlashEvent(data){
        data                  = this.normalizeDataValues(data);
        let execution_index   = data['EXECUTION_INDEX'];
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let signing_pubkey_id = data['SIGNING_PUBKEY_ID'];
        let tick_id           = data['TICK_ID'];
        let amount            = data['AMOUNT'];
        let destination_id    = data['DESTINATION_ID'];
        let block_index       = data['BLOCK_INDEX'];
        let query = `INSERT INTO slash_events
                        (execution_index, target_contract_index, signing_pubkey_id, tick_id,
                         amount, destination_id, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [execution_index, target_contract_index, signing_pubkey_id, tick_id,
                                   amount, destination_id, block_index]);
    },

};

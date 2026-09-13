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
 * XChain Indexer - Database mixin: mints
 * 
 * The queries over the mints table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Get total amount SELF-MINTED (valid MINT actions authored by `address`) for a ticker
    // before `action_index`. Unlike getActionCreditDebitAmount('credits','MINT',...), which
    // also counts MINT credits the address merely received as another mint's DESTINATION,
    // this measures the mints table by the action's source, so only mints the address
    // itself authored count toward MINT_ADDRESS_MAX (MINT_SELF_MINTED_ONLY flag-day).
    async getSelfMintedAmount(tick, address, action_index){
        let total   = 0;
        let tick_id = await this.createTicker(tick);
        let addr_id = await this.createAddress(address);
        let query = `SELECT
                m1.amount,
                t2.decimals
            FROM
                mints m1
                INNER JOIN actions        a1 ON (a1.action_index=m1.action_index)
                INNER JOIN tokens         t2 ON (t2.tick_id=m1.tick_id)
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
            WHERE
                m1.tick_id=? AND a1.source_id=? AND s1.status='valid' AND m1.action_index < ?`;
        let results = await this.doQuery(query, [tick_id, addr_id, action_index]);
        for(let row of results)
            total = this.util.bcadd(total, row.amount, row.decimals);
        return total;
    },

    // Create/Update record in `mints` table
    async createMint(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for this mint
        let exists  = false;
        let query   = "SELECT action_index FROM mints WHERE action_index=? LIMIT 1";
        let args    = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        mints
                    SET
                        tick_id=?,
                        amount=?,
                        destination_id=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO mints (tick_id, amount, destination_id, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [tick_id, amount, destination_id, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

};

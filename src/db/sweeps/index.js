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
 * XChain Indexer - Database mixin: sweeps
 * 
 * The queries over the sweeps table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const U64_MAX = '18446744073709551615';   // BIGINT UNSIGNED

// The five flag columns are nullable BIGINT UNSIGNED, and every SWEEP writes its row valid
// or not, so a refused '-1' or 1e30 flag failed the insert and wedged the block. Only a
// refused row can carry such a value (a valid flag is 0 or 1) and nothing reads these
// columns back into a verdict. A flag that is not a number stores NULL.
function storableFlag(util, value){
    return util.fitIntegerColumn(value, '0', U64_MAX);
}

module.exports = {

    // Create/Update record in `sweeps` table
    async createSweep(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let balances       = storableFlag(this.util, data['BALANCES']);
        let ownerships     = storableFlag(this.util, data['OWNERSHIPS']);
        let orders         = storableFlag(this.util, data['ORDERS']);
        let swaps          = storableFlag(this.util, data['SWAPS']);
        let dispensers     = storableFlag(this.util, data['DISPENSERS']);
        // Check if record already exists for this sweep
        let query = `SELECT
                        action_index
                    FROM
                        sweeps
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
                        sweeps
                    SET
                        destination_id=?,
                        balances=?,
                        ownerships=?,
                        orders=?,
                        swaps=?,
                        dispensers=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO sweeps (destination_id, balances, ownerships, orders, swaps, dispensers, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [destination_id, balances, ownerships, orders, swaps, dispensers, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

};

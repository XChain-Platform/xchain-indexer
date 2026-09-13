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
 * XChain Indexer - Database mixin: dispenses
 * 
 * The queries over the dispenses table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `dispenses` table
    async createDispense(data){
        data                       = this.normalizeDataValues(data);
        let give_coin_id           = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id           = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id            = await this.createCoin(data['GET_COIN']);
        let get_tick_id            = await this.createTicker(data['GET_TICK']);
        let destination_id         = await this.createAddress(data['DESTINATION']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let give_amount            = data['GIVE_AMOUNT'];
        let get_amount             = data['GET_AMOUNT'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        // Check if record already exists for this dispenser
        let query  = `SELECT
                            action_index
                        FROM
                            dispenses
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
                        dispenses
                    SET
                        dispenser_action_index=?,
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        destination_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenses (dispenser_action_index, give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, destination_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [dispenser_action_index, give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, destination_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

    // Handle getting total escrowed and available in a dispenser for a given action_index
    async getDispenserAmountRemaining(action_index){
        let remaining = 0;
        // Get initial amounts from the dispensers table
        let query  = `SELECT 
                        d.give_escrow
                    FROM 
                        dispensers d
                        INNER JOIN index_statuses s ON (s.id=d.status_id)
                    WHERE 
                        d.action_index=? AND
                        s.status=?`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            remaining = results[0].give_escrow;
        // Get any amounts added to escrow via edits and add to remaining
        query = `SELECT 
                    d.give_escrow
                FROM 
                    dispenser_edits d
                    INNER JOIN index_statuses s ON (s.id=d.status_id)
                WHERE 
                    d.dispenser_action_index=? AND
                    s.status=?
                ORDER BY
                    d.action_index ASC`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.give_escrow))
                    remaining = this.util.bcadd(remaining, row.give_escrow, 64);
            }
        }
        // Lookup amounts paid out already from dispenses table
        query = `SELECT
                    d.give_amount
                FROM
                    dispenses d
                    INNER JOIN index_statuses s ON (s.id=d.status_id)
                WHERE
                    d.dispenser_action_index=?  AND
                    s.status=?
                ORDER BY action_index ASC`;
        args = [action_index, 'valid'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.give_amount))
                    remaining = this.util.bcsub(remaining, row.give_amount, 64);
            }
        }
        return remaining;
    },

};

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
 * XChain Indexer - Database mixin part: dispensers, the writers
 *
 * The create/update writers for dispensers and its status, edit, close, cancel and
 * expire tables. Merged into the dispensers mixin by db/dispensers.js, which
 * db/index.js installs onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// createDispenser's UPDATE of an existing dispensers row, every column rewritten.
const DISPENSER_UPDATE_SQL = `UPDATE
                        dispensers
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_escrow=?,
                        give_ownership=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_address_id=?,
                        fiat_id=?,
                        fiat_amount=?,
                        oracle_address_id=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;

module.exports = {

    // Create/Update record in `dispensers` table
    async createDispenser(data){
        data                  = this.normalizeDataValues(data);
        let give_coin_id      = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id      = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id       = await this.createCoin(data['GET_COIN']);
        let get_tick_id       = await this.createTicker(data['GET_TICK']);
        let get_address_id    = await this.createAddress(data['GET_ADDRESS']);
        let fiat_id           = await this.createFiat(data['FIAT_CODE']);
        let oracle_address_id = (!this.util.isNull(data['ORACLE_ADDRESS'])) ? await this.createAddress(data['ORACLE_ADDRESS']) : null;
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let give_amount       = data['GIVE_AMOUNT'];
        let get_amount        = data['GET_AMOUNT'];
        let give_escrow       = data['GIVE_ESCROW'];
        let give_ownership    = (data['GIVE_OWNERSHIP']==1) ? 1 : 0;
        let fiat_amount       = data['FIAT_AMOUNT'];
        let expiration        = data['EXPIRATION'];
        let allow_list        = data['ALLOW_LIST'];
        let block_list        = data['BLOCK_LIST'];
        // Check if record already exists for this dispenser
        let query  = `SELECT
                            action_index
                        FROM
                            dispensers
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = DISPENSER_UPDATE_SQL;
            args = [give_coin_id, give_tick_id, give_amount, give_escrow, give_ownership, get_coin_id, get_tick_id, get_amount, get_address_id, fiat_id, fiat_amount, oracle_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO dispensers (give_coin_id, give_tick_id, give_amount, give_escrow, give_ownership, get_coin_id, get_tick_id, get_amount, get_address_id, fiat_id, fiat_amount, oracle_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [give_coin_id, give_tick_id, give_amount, give_escrow, give_ownership, get_coin_id, get_tick_id, get_amount, get_address_id, fiat_id, fiat_amount, oracle_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        }
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `dispenser_statuses` table
    // @param {action_index}            integer Action index of action
    // @param {dispenser_action_index}  integer Action index of dispenser
    // @param {status}                  string  Status of the referenced dispenser (open/complete/closing/cancelled/expired)
    // @param {cancelled_by}            string  (optional) Address that triggered the cancel - recorded for the 'cancelling' status so dispenser_close can route escrow correctly
    async createDispenserStatus(action_index, dispenser_action_index, status, cancelled_by){
        // Normalize data
        let status_id       = await this.createStatus(status);
        let cancelled_by_id = (!this.util.isNull(cancelled_by)) ? await this.createAddress(cancelled_by) : null;
        // Check if record already exists for this in order_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_statuses
                        WHERE
                            action_index=? AND
                            dispenser_action_index=?`;
        let args = [action_index, dispenser_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_statuses
                    SET
                        status_id=?,
                        cancelled_by_id=?
                    WHERE
                        action_index=? AND
                        dispenser_action_index=?`;
            args = [status_id, cancelled_by_id, action_index, dispenser_action_index];
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_statuses (status_id, cancelled_by_id, action_index, dispenser_action_index) values (?, ?, ?, ?)`;
            args  = [status_id, cancelled_by_id, action_index, dispenser_action_index];
        }
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `dispenser_edits` table
    async createDispenserEdit(data){
        data                       = this.normalizeDataValues(data);
        let memo_id                = await this.createMemo(data['MEMO']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        let give_escrow            = data['GIVE_ESCROW'];
        let expiration             = data['EXPIRATION'];
        let allow_list             = data['ALLOW_LIST'];
        let block_list             = data['BLOCK_LIST'];
        // Check if record already exists for this dispenser_edits
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_edits
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
                        dispenser_edits
                    SET
                        give_escrow=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        dispenser_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_edits (give_escrow, expiration, allow_list, block_list, memo_id, status_id, dispenser_action_index, action_index) values (?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [give_escrow, expiration, allow_list, block_list, memo_id, status_id, dispenser_action_index, action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `dispenser_closes` table
    async createDispenserClose(data){
        data                       = this.normalizeDataValues(data);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        // Check if record already exists for this in dispenser_closes
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_closes
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
                        dispenser_closes
                    SET
                        status_id=?,
                        dispenser_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_closes (status_id, dispenser_action_index, action_index) values (?, ?, ?)`;
        }
        args    = [status_id, dispenser_action_index, action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `dispenser_cancels` table
    async createDispenserCancel(data){
        data                       = this.normalizeDataValues(data);
        let memo_id                = await this.createMemo(data['MEMO']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        // Check if record already exists for this in dispenser_cancels
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_cancels
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
                        dispenser_cancels
                    SET
                        memo_id=?,
                        status_id=?,
                        dispenser_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_cancels (memo_id, status_id, dispenser_action_index, action_index) values (?, ?, ?, ?)`;
        }
        args    = [memo_id, status_id, dispenser_action_index, action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `order_expires` table
    // @param {action_index}          integer Action index of action
    // @param {dispenser_action_tick} integer Action index of dispenser
    // @param {status}                string  Status of the expire (valid/invalid)
    async createDispenserExpire(action_index, dispenser_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in order_expires table
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_expires
                        WHERE
                            action_index=? AND
                            dispenser_action_index=?`;
        let args = [action_index, dispenser_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_expires
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        dispenser_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_expires (status_id, action_index, dispenser_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, dispenser_action_index];
        results = await this.doQuery(query, args);
    },

};

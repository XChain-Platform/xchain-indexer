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
 * XChain Indexer - Database mixin part: issues / issue_writer
 *
 * The upsert of one ISSUE action into the issues table.
 * Merged into the issues mixin by db/issues/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `issues` table
    async createIssue(data){
        let record = await issueRecord.fields(this, data);
        // Check if record already exists for this ISSUE action
        let query = `SELECT action_index FROM issues WHERE action_index=?`;
        let args  = [record.action_index]
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = issueRecord.updateSql();
        } else {
            // INSERT record
            query = issueRecord.insertSql();
        }
        args    = record.args;
        results = await this.doQuery(query, args);
    },

};

// The pieces of createIssue, kept off the exported object so Database.prototype gains no
// method: the column values one ISSUE writes (interning its tick, address, memo and status
// ids in that order) and the UPDATE / INSERT statements that bind them in one argument order.
const issueRecord = {

    async fields(db, data){
        data                   = db.normalizeDataValues(data);
        let action_index       = data['ACTION_INDEX'];
        let description        = data['DESCRIPTION'];
        let max_supply         = data['MAX_SUPPLY'];
        let max_mint           = data['MAX_MINT'];
        let mint_supply        = data['MINT_SUPPLY'];
        let mint_address_max   = data['MINT_ADDRESS_MAX'];
        let mint_start_block   = data['MINT_START_BLOCK'];
        let mint_stop_block    = data['MINT_STOP_BLOCK'];
        let decimals           = data['DECIMALS'];
        let status             = data['STATUS'];
        let lock_max_supply    = data['LOCK_MAX_SUPPLY'];
        let lock_mint          = data['LOCK_MINT'];
        let lock_mint_supply   = data['LOCK_MINT_SUPPLY'];
        let lock_max_mint      = data['LOCK_MAX_MINT'];
        let lock_description   = data['LOCK_DESCRIPTION'];
        let lock_sleep         = data['LOCK_SLEEP'];
        let lock_callback      = data['LOCK_CALLBACK'];
        let callback_block     = data['CALLBACK_BLOCK'];
        let callback_amount    = data['CALLBACK_AMOUNT'];
        let allow_list         = data['ALLOW_LIST'];
        let block_list         = data['BLOCK_LIST'];
        // Token-bridge opt-in fields, stored as RAW WIRE STRINGS exactly as ISSUE carried
        // them. That is what makes "empty means unchanged" true on this table: getTokenInfo
        // replays the issues rows and skips an empty field, and a typed/NOT NULL column
        // could not express "the action did not carry this field at all".
        let bridge_chains      = data['BRIDGE_CHAINS'];
        let min_depth          = data['MIN_DEPTH'];
        let lock_bridge        = data['LOCK_BRIDGE'];
        let callback_tick_id   = await db.createTicker(data['CALLBACK_TICK']);
        let tick_id            = await db.createTicker(data['TICK']);
        let transfer_id        = await db.createAddress(data['TRANSFER']);
        let transfer_supply_id = await db.createAddress(data['TRANSFER_SUPPLY']);
        let memo_id            = await db.createMemo(data['MEMO']);
        let status_id          = await db.createStatus(data['STATUS']);
        return { action_index, args: [tick_id, max_supply, max_mint, decimals, description, mint_supply, transfer_id, transfer_supply_id, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, bridge_chains, min_depth, lock_bridge, memo_id, status_id, action_index ] };
    },

    updateSql(){
        return `UPDATE
                        issues
                    SET
                        tick_id=?,
                        max_supply=?,
                        max_mint=?,
                        decimals=?,
                        description=?,
                        mint_supply=?,
                        transfer_id=?,
                        transfer_supply_id=?,
                        lock_max_supply=?,
                        lock_mint=?,
                        lock_mint_supply=?,
                        lock_max_mint=?,
                        lock_description=?,
                        lock_sleep=?,
                        lock_callback=?,
                        callback_block=?,
                        callback_tick_id=?,
                        callback_amount=?,
                        allow_list=?,
                        block_list=?,
                        mint_address_max=?,
                        mint_start_block=?,
                        mint_stop_block=?,
                        bridge_chains=?,
                        min_depth=?,
                        lock_bridge=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
    },

    insertSql(){
        return `INSERT INTO issues (
                        tick_id, 
                        max_supply, 
                        max_mint, 
                        decimals, 
                        description, 
                        mint_supply, 
                        transfer_id, 
                        transfer_supply_id, 
                        lock_max_supply, 
                        lock_mint, 
                        lock_mint_supply, 
                        lock_max_mint, 
                        lock_description,
                        lock_sleep,
                        lock_callback,
                        callback_block,
                        callback_tick_id,
                        callback_amount,
                        allow_list,
                        block_list,
                        mint_address_max,
                        mint_start_block,
                        mint_stop_block,
                        bridge_chains,
                        min_depth,
                        lock_bridge,
                        memo_id,
                        status_id,
                        action_index
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    },

};

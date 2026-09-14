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
 * XChain Indexer - Database mixin part: swaps / swap_info
 *
 * The read of one SWAP offer with its latest status and valid edits folded in,
 * and the upsert of the swap_edits rows that read folds.
 * Merged into the swaps mixin by db/swaps.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Return swap info for given action_index
    // Resolve a single swap by its (locally-unique) action_index. `coin` matches the
    // swap's GET coin (same-chain: the local coin; cross-chain: the counterparty coin).
    // Pass the counterparty coin (e.g. cross_settle) to assert the get side, or null to
    // look up purely by action_index - what cancel/expire must do, since they operate on
    // a local swap by index and cannot assume its get_coin is local.
    async getSwapInfo(coin, action_index){
        let swap = false;
        let query = swapInfoSql(coin);
        let args  = coin ? [coin, action_index] : [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            swap = {};
            swap['GIVE_COIN'] = this.config['COIN'];
            for(let key in results[0]){
                let name  = String(key).toUpperCase()
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'GIVE_OWNERSHIP', 'GET_OWNERSHIP'].includes(name))
                    value = Number(value);
                swap[name] = value;
            }
            // Ownership swaps expose virtual '1' for the ownership side's GIVE_AMOUNT /
            // GET_AMOUNT so the matching engine can compare amounts uniformly. Settlement
            // code branches on GIVE_OWNERSHIP / GET_OWNERSHIP flags rather than the
            // synthetic amount.
            if(swap['GIVE_OWNERSHIP'] == 1 && this.util.isNull(swap['GIVE_AMOUNT']))
                swap['GIVE_AMOUNT'] = '1';
            if(swap['GET_OWNERSHIP']  == 1 && this.util.isNull(swap['GET_AMOUNT']))
                swap['GET_AMOUNT']  = '1';
            // Get updated swap properties from the swap_edits table
            let edit = await this.getSwapEdits(action_index);
            if(edit.expiration)
                swap['EXPIRATION'] = edit.expiration;
            if(edit.allow_list)
                swap['ALLOW_LIST'] = edit.allow_list;
            if(edit.block_list)
                swap['BLOCK_LIST'] = edit.block_list;
        }
        return swap;
    },

    // Return swap edit information for given action_index
    async getSwapEdits(action_index){
        // Define empty edit object
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let query  = `SELECT 
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list
                    FROM 
                        swap_edits s1
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE 
                        s1.swap_action_index=? AND
                        s2.status=?
                    ORDER BY
                        s1.action_index ASC`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = Number(row.expiration);
                if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = Number(row.allow_list);
                if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = Number(row.block_list);
            }
        }
        return edit;
    },

    // Create/Update record in `swap_edits` table
    async createSwapEdit(data){
        data = this.normalizeDataValues(data);
        // Standardize LIST values to numeric or NULL
        for(let list of this.config['LIST_FIELDS']){
            if(this.util.isNull(data[list]) || !this.util.isNumeric(data[list]))
                delete data[list];
        }
        // Normalize data
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let swap_action_index = data['SWAP_ACTION_INDEX'];
        let expiration        = data['EXPIRATION'];
        let allow_list        = data['ALLOW_LIST'];
        let block_list        = data['BLOCK_LIST'];
        // Check if record already exists for this swap_edits
        let query  = `SELECT
                            action_index
                        FROM
                            swap_edits
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
                        swap_edits
                    SET
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        swap_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_edits (expiration, allow_list, block_list, memo_id, status_id, swap_action_index, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [expiration, allow_list, block_list, memo_id, status_id, swap_action_index, action_index];
        results = await this.doQuery(query, args);
    },

};

// The statement getSwapInfo runs, kept off the exported object so Database.prototype gains
// no method. It joins the swap to its LATEST swap_statuses row (the MAX(action_index)
// subquery); with a coin it also asserts the get side, and then binds [coin, action_index],
// without one it binds [action_index] alone.
function swapInfoSql(coin){
    return `SELECT
                        s1.action_index,
                        t2.tick as give_tick,
                        s1.give_amount,
                        s1.give_ownership,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        s1.get_amount,
                        s1.get_ownership,
                        a2.address as source,
                        a3.address as get_address,
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list,
                        m1.memo,
                        s3.status,
                        s4.status as swap_status,
                        s1.payout_legs,
                        b1.block_index,
                        b1.block_time
                    FROM
                        swaps s1
                        INNER JOIN actions         a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=s1.get_address_id)
                        INNER JOIN index_tickers   t2 ON (t2.id=s1.give_tick_id)
                        INNER JOIN index_tickers   t3 ON (t3.id=s1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=s1.get_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=s1.memo_id)
                        INNER JOIN swap_statuses   s2 ON (s2.swap_action_index=s1.action_index)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                        INNER JOIN index_statuses  s4 ON (s4.id=s2.status_id)
                    WHERE 
                        s2.action_index = (
                            SELECT
                                MAX(s5.action_index)
                            FROM
                                swap_statuses s5
                            WHERE
                                s5.swap_action_index=s1.action_index
                        ) AND
                        ${coin ? 'c1.coin=? AND' : ''}
                        s1.action_index=?
                    LIMIT 1`;
}

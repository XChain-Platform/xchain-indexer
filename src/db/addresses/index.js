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
 * XChain Indexer - Database mixin: addresses
 * 
 * The queries over the addresses table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create record in `addresses` table
    async createAddressOption(data){
        data                     = this.normalizeDataValues(data);
        let status_id            = await this.createStatus(data['STATUS']);
        let memo_id              = await this.createMemo(data['MEMO']);
        let action_index         = data['ACTION_INDEX'];
        let fee_preference       = data['FEE_PREFERENCE'];
        let require_memo         = data['REQUIRE_MEMO'];
        let dispenser_preference = data['DISPENSER_PREFERENCE'];
        // Check if record already exists for this address
        let query  = "SELECT action_index FROM addresses WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE
                        addresses
                    SET
                        fee_preference=?,
                        require_memo=?,
                        dispenser_preference=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            query = "INSERT INTO addresses (fee_preference, require_memo, dispenser_preference, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)";
        }
        args    = [fee_preference, require_memo, dispenser_preference, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

    // Get address preferences for a given address
    async getAddressPreferences(address, block_index, action_index){
        let id   = await this.createAddress(address);
        // Set default address preferences
        let data = {};
        data['FEE_PREFERENCE']       = 2; // 2=Donate FEES to development
        data['REQUIRE_MEMO']         = 0; // 0=Do NOT Require memo on SENDs to this address
        data['DISPENSER_PREFERENCE'] = 1; // 1=Only owner can open dispenser on this address
        // Build out the SQL query and arguments
        let sql  = '';
        let args = [id, 'valid'];
        // Query using either block_index OR action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND a1.action_index < ?";
            args.push(action_index);
        } else if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND t1.block_index < ?";
            args.push(block_index);
        }
        // Lookup the address preferences.
        //
        // Format 1 is excluded on purpose: a controller bind writes an `addresses` row so its verdict is
        // readable, but that row carries no preferences, and Number(NULL) here would read back
        // as fee_preference=0 (destroy) for every later action by that address. The guard names the one
        // format rather than filtering on NULL columns, because a format-0 row with a blank preference
        // has always read back as 0 and must keep doing so.
        let query = `SELECT
                a1.fee_preference,
                a1.require_memo,
                a1.dispenser_preference
            FROM
                addresses                 a1
                INNER JOIN actions        a2 ON (a1.action_index=a2.action_index)
                INNER JOIN transactions   t1 ON (t1.tx_index=a2.tx_index)
                INNER JOIN index_statuses s1 ON (s1.id=a1.status_id)
            WHERE
                t1.source_id=? AND
                (a2.action_format IS NULL OR a2.action_format!=1) AND
                s1.status=?` + sql + `
            ORDER BY
                a1.action_index ASC`;
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                data['FEE_PREFERENCE'] = Number(row.fee_preference);
                data['REQUIRE_MEMO']   = Number(row.require_memo);
                if(!this.util.isNull(row.dispenser_preference))
                    data['DISPENSER_PREFERENCE'] = Number(row.dispenser_preference);
            }
        }
        return data;
    },

    // Append an address controller bind/unbind event (self-signed; no bound_by_id - the account IS
    // the signer). `evt` carries action_index, address_id, action_class, contract_index, is_unbind,
    // cooldown_blocks, cooldown_end_block, block_index.
    async recordAddressControllerEvent(evt){
        let query = `INSERT INTO address_controllers
                        (action_index, address_id, action_class, contract_index,
                         is_unbind, cooldown_blocks, cooldown_end_block, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [evt.action_index, evt.address_id, evt.action_class, evt.contract_index,
            evt.is_unbind ? 1 : 0, evt.cooldown_blocks, evt.cooldown_end_block, evt.block_index]);
    },

};

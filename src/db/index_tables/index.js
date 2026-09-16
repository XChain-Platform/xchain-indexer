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
 * XChain Indexer - Database mixin: index_tables
 * 
 * The queries over the index_tables table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
// The index_tables mixin is cut into parts by behaviour under index_tables/; this entry merges them
// back into the one method set db/index.js installs, at the position those methods held here.
const addresses    = require('./addresses.js');
const tickers      = require('./tickers.js');
const expiredItems = require('./expired_items.js');

module.exports = {

    // Lookup a record in the `index_transactions` table and return record id
    async getTransactionId(hash){
        // Genesis intern cache: the same synthetic tx hash is resolved several times per
        // action (createTxIndex/createActionIndex/mappings); serve non-null hits from memory.
        if(this._internCache !== null){
            let hit = this._internCache.tx.get(hash);
            if(hit !== undefined)
                return hit;
        }
        let id    = null;
        let query = "SELECT id FROM index_transactions WHERE `hash`=? LIMIT 1"
        let results = await this.doQuery(query, [hash]);
        if(results.length > 0)
            id = Number(results[0].id);
        if(id !== null && this._internCache !== null)
            this._internCache.tx.set(hash, id);
        return id;
    },

    // Create records in the 'index_transactions' table and return record id
    async createTransaction(hash){
        // Ignore empty hash and return NULL
        if(this.util.isNull(hash))
            return null;
        // Truncate to 250 characters
        hash = String(hash).substring(0,250);
        let id = await this.getTransactionId(hash);
        // Create transaction if it does not already exist
        if(id === null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: a
            // concurrent insert of the same hash is skipped (no duplicate-key throw),
            // and the refetch resolves to the canonical row id.
            let query   = "INSERT IGNORE INTO index_transactions (`hash`) values (?)";
            await this.doQuery(query, [hash]);
            id = await this.getTransactionId(hash);
        }
        // Convert id to a number
        if(id !== null)
            id = Number(id);
        return id;
    },

    ...addresses,

    // Lookup a record in the `index_actions` table and return record id
    async getActionId(action){
        let id    = null;
        let query = "SELECT id FROM index_actions WHERE action=? LIMIT 1";
        let results = await this.doQuery(query, [action]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_actions' table and return record id
    async createAction(action){
        var id = await this.getActionId(action);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch keeps this consistent with the other index_*
            // upserts. NOTE: index_actions carries only a non-unique index, so IGNORE
            // does not itself prevent duplicate rows under true concurrency - the
            // single-threaded block-processing loop is what serializes these inserts.
            let query = "INSERT IGNORE INTO index_actions (action) values (?)";
            await this.doQuery(query, [action]);
            id = await this.getActionId(action);
        }
        return id;
    },

    ...tickers,

    // Lookup a record in the `index_statuses` table and return record id
    async getStatusId(status){
        let id    = null;
        let query = "SELECT id FROM index_statuses WHERE status=? LIMIT 1";
        let results = await this.doQuery(query, [status]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_statuses' table and return record id
    async createStatus(status){
        // Ignore empty status and return NULL
        if(this.util.isNull(status))
            return null;
        var id = await this.getStatusId(status);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_statuses (status) values (?)";
            await this.doQuery(query, [status]);
            id = await this.getStatusId(status);
        }
        return id;
    },

    // Lookup a record in the `index_memos` table and return record id
    async getMemoId(memo){
        let id    = null;
        let query = "SELECT id FROM index_memos WHERE memo=? LIMIT 1";
        let results = await this.doQuery(query, [memo]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_memos' table and return record id
    async createMemo(memo){
        // Ignore empty memo and return NULL
        if(this.util.isNull(memo))
            return null;
        // Truncate memos to 250 characters
        memo = String(memo).substring(0,250);
        var id = await this.getMemoId(memo);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_memos (memo) values (?)";
            await this.doQuery(query, [memo]);
            id = await this.getMemoId(memo);
        }
        return id;
    },

    // Lookup a record in the `index_mime_types` table and return record id
    async getMimeTypeId(type){
        let id    = null;
        let query = "SELECT id FROM index_mime_types WHERE `type`=? LIMIT 1";
        let args  = [type];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_mime_types' table and return record id
    async createMimeType(type){
        // Ignore empty mime type and return NULL
        if(this.util.isNull(type))
            return null;
        var id = await this.getMimeTypeId(type);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_mime_types (`type`) values (?)";
            let args  = [type];
            await this.doQuery(query, args);
            id = await this.getMimeTypeId(type);
        }
        return id;
    },

    // Lookup a record in the `index_coins` table and return record id
    async getCoinId(coin){
        let id    = null;
        let query = "SELECT id FROM index_coins WHERE `coin`=? LIMIT 1";
        let args  = [coin];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_coins' table and return record id
    async createCoin(coin){
        // Ignore empty coin and return NULL
        if(this.util.isNull(coin))
            return null;
        var id = await this.getCoinId(coin);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_coins (`coin`) values (?)";
            let args  = [coin];
            await this.doQuery(query, args);
            id = await this.getCoinId(coin);
        }
        return id;
    },

    // Lookup a record in the `index_fiats` table and return record id
    async getFiatId(code){
        let id    = null;
        let query = "SELECT id FROM index_fiats WHERE `code`=? LIMIT 1";
        let args  = [code];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_fiats' table and return record id
    async createFiat(code){
        // Ignore empty fiat and return NULL
        if(this.util.isNull(code))
            return null;
        var id = await this.getFiatId(code);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_fiats (`code`) values (?)";
            let args  = [code];
            await this.doQuery(query, args);
            id = await this.getFiatId(code);
        }
        return id;
    },

    // Verify that a given action_index is associated with a `valid` transaction
    async isActionIndexValid(action_index){
        let valid = false;
        let table = await this.getActionIndexTable(action_index);
        if(!this.util.isNull(table)){
            let query = `SELECT 
                            m.action_index
                        FROM 
                            ` + table + ` m
                            LEFT JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            m.action_index=? AND
                            s.status='valid'`;
            let args = [action_index];
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                valid = true;
        }
        return valid;
    },

    // Resolve a deterministic index_addresses id back to its address string. Used by
    // VOTE v2 to find the deposit refund target (deposit_address_id was assigned via
    // createAddress at creation, so it is in the deterministic set). Null if missing.
    async getAddressById(id){
        if(this.util.isNull(id)) return null;
        let results = await this.doQuery(`SELECT address FROM index_addresses WHERE id=? LIMIT 1`, [id]);
        return (results.length > 0 && !this.util.isNull(results[0].address)) ? String(results[0].address) : null;
    },

    ...expiredItems,

    /*
     * Pubkey index methods (index_pubkeys table)
     */

    // Get pubkey id from index_pubkeys table
    async getPubkeyId(pubkey){
        let id    = null;
        let query = "SELECT id FROM index_pubkeys WHERE `pubkey`=? LIMIT 1";
        let results = await this.doQuery(query, [pubkey]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create record in index_pubkeys table and return record id
    async getOrCreatePubkeyId(pubkey){
        // Ignore empty pubkey and return NULL
        if(this.util.isNull(pubkey))
            return null;
        // Normalize to lowercase hex
        pubkey = String(pubkey).toLowerCase().substring(0, 64);
        let id = await this.getPubkeyId(pubkey);
        // Create pubkey if it does not already exist
        if(id === null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query   = "INSERT IGNORE INTO index_pubkeys (`pubkey`) values (?)";
            await this.doQuery(query, [pubkey]);
            id = await this.getPubkeyId(pubkey);
        }
        return id;
    },

    // Get status string by status_id
    async getStatusString(status_id){
        if(this.util.isNull(status_id))
            return null;
        let query = `SELECT status FROM index_statuses WHERE id=? LIMIT 1`;
        let results = await this.doQuery(query, [status_id]);
        if(results.length > 0)
            return results[0].status;
        return null;
    },

};

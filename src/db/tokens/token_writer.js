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
 * XChain Indexer - Database mixin part: tokens / token_writer
 *
 * The upsert of one token's derived state into the tokens table.
 * Merged into the tokens mixin by db/tokens.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `tokens` table
    async createToken(data){
        let record = await tokenRecord.fields(this, data);
        // Check if record already exists for this token
        let query  = "SELECT id FROM tokens WHERE tick_id=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [record.tick_id]);
        if(results.length > 0)
            exists = true;
        let args = [];
        if(exists){
            // UPDATE record
            query = tokenRecord.updateSql();
            args = record.updateArgs;
        } else {
            // INSERT record
            query = tokenRecord.insertSql();
            args    = record.insertArgs;
        }
        results = await this.doQuery(query, args);

    },

};

// The pieces of createToken, kept off the exported object so Database.prototype gains no
// method: the column values one token writes (interning its callback tick, tick and owner
// ids in that order) with the argument list each statement binds, and the UPDATE / INSERT
// statements themselves. The INSERT binds action_index twice, as action_index and as
// last_action_index; the UPDATE touches only last_action_index.
const tokenRecord = {

    async fields(db, data){
        data                   = db.normalizeDataValues(data);
        let supply             = (!db.util.isNull(data['SUPPLY']) &&               db.util.isNumeric(data['SUPPLY'])) ? data['SUPPLY'] : 0;
        let max_supply         = (!db.util.isNull(data['MAX_SUPPLY']) &&           db.util.isNumeric(data['MAX_SUPPLY'])) ? data['MAX_SUPPLY'] : 0;
        let max_mint           = (!db.util.isNull(data['MAX_MINT']) &&             db.util.isNumeric(data['MAX_MINT'])) ? data['MAX_MINT'] : 0;
        let mint_supply        = (!db.util.isNull(data['MINT_SUPPLY']) &&          db.util.isNumeric(data['MINT_SUPPLY'])) ? data['MINT_SUPPLY'] : 0;
        let mint_address_max   = (!db.util.isNull(data['MINT_ADDRESS_MAX']) &&     db.util.isNumeric(data['MINT_ADDRESS_MAX'])) ? data['MINT_ADDRESS_MAX'] : 0;
        let mint_start_block   = (!db.util.isNull(data['MINT_START_BLOCK']) &&     db.util.isNumeric(data['MINT_START_BLOCK'])) ? data['MINT_START_BLOCK'] : 0;
        let mint_stop_block    = (!db.util.isNull(data['MINT_STOP_BLOCK']) &&      db.util.isNumeric(data['MINT_STOP_BLOCK'])) ? data['MINT_STOP_BLOCK'] : 0;
        let callback_amount    = (!db.util.isNull(data['CALLBACK_AMOUNT']) &&      db.util.isNumeric(data['CALLBACK_AMOUNT'])) ? data['CALLBACK_AMOUNT'] : 0;
        let allow_list         = (!db.util.isNull(data['ALLOW_LIST']) &&           db.util.isNumeric(data['ALLOW_LIST'])) ? parseInt(data['ALLOW_LIST']) : null;
        let block_list         = (!db.util.isNull(data['BLOCK_LIST']) &&           db.util.isNumeric(data['BLOCK_LIST'])) ? parseInt(data['BLOCK_LIST']) : null;
        let decimals           = (!db.util.isNull(data['DECIMALS']) &&             db.util.isNumeric(data['DECIMALS'])) ? parseInt(data['DECIMALS']) : 0;
        // Token-bridge opt-in, PARSED state (the issues row above keeps the raw wire text).
        // The '-' sentinel is the wire spelling of "no destination chains" and lands here as
        // NULL, so this column always reads as the effective destination list: empty means
        // not bridgeable, which is what the explorer, the wallet and the hub's poll want.
        // MIN_DEPTH is raise-only, so an absent value is NULL and the federation falls back
        // to the platform confirmation depth. `bridged` is deliberately NOT written here: it
        // is set by the first applied XBRIDGE v3 lock and no ISSUE may set or clear it.
        let bridge_chains      = (!db.util.isNull(data['BRIDGE_CHAINS']) && String(data['BRIDGE_CHAINS']) !== '-') ? String(data['BRIDGE_CHAINS']) : null;
        let min_depth          = (!db.util.isNull(data['MIN_DEPTH']) &&            db.util.isNumeric(data['MIN_DEPTH'])) ? parseInt(data['MIN_DEPTH']) : null;
        let lock_bridge        = (data['LOCK_BRIDGE']==1) ? 1 : 0;
        // Force any amount values to the correct decimal precision
        if(db.util.isNumeric(decimals) && decimals >= db.config.MIN_TOKEN_DECIMALS && decimals <= db.config.MAX_TOKEN_DECIMALS){
            max_supply         = db.util.bcformat(max_supply, decimals);
            max_mint           = db.util.bcformat(max_mint, decimals);
            mint_supply        = db.util.bcformat(mint_supply, decimals);
            mint_address_max   = db.util.bcformat(mint_address_max, decimals);
            // callback_amount    = db.util.bcformat(callback_amount, decimals);
        }
        let description        = data['DESCRIPTION'];
        let action_index       = data['ACTION_INDEX'];
        // Force lock fields to integer values 
        let lock_max_supply    = (data['LOCK_MAX_SUPPLY']==1) ? 1 : 0;
        let lock_mint          = (data['LOCK_MINT']==1) ? 1 : 0;
        // LOCK_MINT_SUPPLY is the seventh token lock and is folded by getTokenInfo() from the
        // issues rows like the other six. It was missing from this derivation (and from the
        // INSERT/UPDATE below), so tokens.lock_mint_supply sat at its column default forever
        // and every read API reported the lock unset even where the chain enforces it (#).
        // Consensus never depended on this column (issue.js re-folds `issues`), but the wallet's
        // mint form and lock matrix read it and would offer a mint/lock the chain then rejects.
        let lock_mint_supply   = (data['LOCK_MINT_SUPPLY']==1) ? 1 : 0;
        let lock_max_mint      = (data['LOCK_MAX_MINT']==1) ? 1 : 0;
        let lock_description   = (data['LOCK_DESCRIPTION']==1) ? 1 : 0;
        let lock_sleep         = (data['LOCK_SLEEP']==1) ? 1 : 0;
        let lock_callback      = (data['LOCK_CALLBACK']==1) ? 1 : 0;
        let callback_block     = (data['CALLBACK_BLOCK']>0) ? data['CALLBACK_BLOCK'] : 0;
        let callback_tick_id   = await db.createTicker(data['CALLBACK_TICK']);
        let tick_id            = await db.createTicker(data['TICK']);
        let owner_id           = await db.createAddress(data['OWNER']);
        return { tick_id,
            updateArgs: [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, bridge_chains, min_depth, lock_bridge, supply, owner_id, action_index, tick_id],
            insertArgs: [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, bridge_chains, min_depth, lock_bridge, supply, owner_id, action_index, action_index, tick_id] };
    },

    updateSql(){
        return `UPDATE
                        tokens
                    SET
                        max_supply=?,
                        max_mint=?,
                        decimals=?,
                        description=?,
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
                        supply=?,
                        owner_id=?,
                        last_action_index=?
                    WHERE
                        tick_id=?`;
    },

    insertSql(){
        return `INSERT INTO tokens (
                        max_supply, 
                        max_mint, 
                        decimals, 
                        description, 
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
                        supply,
                        owner_id,
                        action_index,
                        last_action_index,
                        tick_id
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    },

};

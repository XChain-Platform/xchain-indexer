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
 * XChain Indexer - Database mixin: issues
 * 
 * The queries over the issues table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Handle getting token information using issues table
    // @param {tick}            string  Ticker name or Ticker ID
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async getTokenInfo(tick, block_index, action_index){
        let data = false,
            sql  = '',
            args = [];
        // Only query database if we actually have a tick or tick_id passed
        if(!this.util.isNull(tick)){
            // Get the tick_id for the given ticker
            let tick_id = await this.createTicker(tick);
            // Add tick_id to SQL query arguments
            args.push(tick_id);
            // If a block_index was given, only lookup tokens created before or in given block_index
            if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
                sql += " AND t1.block_index <= ?";
                args.push(parseInt(block_index));
            }
            // If a action_index was given, only lookup tokens created before given action_index
            if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
                sql += " AND a1.action_index < ?";
                args.push(parseInt(action_index));
            }
            // Build out SQL query based on search params
            let query = `SELECT 
                            i.max_supply,
                            i.max_mint,
                            i.decimals,
                            i.description,
                            i.lock_max_supply,
                            i.lock_mint_supply,
                            i.lock_mint,
                            i.lock_max_mint,
                            i.lock_description,
                            i.lock_sleep,
                            i.lock_callback,
                            i.callback_block,
                            i.callback_amount,
                            i.mint_address_max,
                            i.mint_start_block,
                            i.mint_stop_block,
                            i.allow_list,
                            i.block_list,
                            i.bridge_chains,
                            i.min_depth,
                            i.lock_bridge,
                            i.action_index,
                            t1.block_index,
                            t2.tick,
                            t3.tick as callback_tick,
                            a2.address as owner,
                            a3.address as transfer,
                            tk.bridged as bridged
                        FROM
                            issues i
                            INNER JOIN actions            a1 ON (a1.action_index=i.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN index_tickers      t2 ON (t2.id=i.tick_id)
                            INNER JOIN index_addresses    a2 ON (a2.id=a1.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=i.status_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=i.transfer_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=i.callback_tick_id)
                            LEFT  JOIN tokens             tk ON (tk.tick_id=i.tick_id)
                        WHERE
                            s1.status='valid' AND
                            i.tick_id=?` + sql + `
                        ORDER BY 
                            i.action_index ASC`;
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                // Define data object
                if(!data)
                    data = {};
                // Loop through ISSUE transactions for the given ticker
                for(let row of results){
                    // Define object of values for this ISSUE tx
                    let arr  = {};
                    arr['ACTION_INDEX']      = row.action_index;
                    arr['TICK']              = row.tick;
                    arr['TICK_ID']           = tick_id;
                    arr['OWNER']             = (row.transfer) ? row.transfer : row.owner;
                    arr['MAX_SUPPLY']        = row.max_supply;
                    arr['MAX_MINT']          = row.max_mint;
                    // Force decimal precision to a integer value
                    arr['DECIMALS']          = (!this.util.isNull(row.decimals)) ? parseInt(row.decimals) : 0;
                    arr['DESCRIPTION']       = row.description;
                    arr['LOCK_MAX_SUPPLY']   = row.lock_max_supply;
                    arr['LOCK_MINT_SUPPLY']  = row.lock_mint_supply;
                    arr['LOCK_MINT']         = row.lock_mint;
                    arr['LOCK_MAX_MINT']     = row.lock_max_mint;
                    arr['LOCK_DESCRIPTION']  = row.lock_description;
                    arr['LOCK_SLEEP']        = row.lock_sleep;
                    arr['LOCK_CALLBACK']     = row.lock_callback;
                    arr['CALLBACK_TICK']     = row.callback_tick;
                    arr['CALLBACK_BLOCK']    = row.callback_block;
                    arr['CALLBACK_AMOUNT']   = row.callback_amount;
                    arr['ALLOW_LIST']        = row.allow_list;
                    arr['BLOCK_LIST']        = row.block_list;
                    // Token-bridge opt-in (ISSUE format 7). Replayed from `issues` exactly like
                    // the mint window and the other locks: an EMPTY field inherits the prior
                    // value (which is why "no destination chains" needs the '-' sentinel and
                    // cannot be spelled as an empty field), and LOCK_BRIDGE gets the shared
                    // cannot-unset treatment below for free because its key starts with 'LOCK_'.
                    arr['BRIDGE_CHAINS']     = row.bridge_chains;
                    arr['MIN_DEPTH']         = row.min_depth;
                    arr['LOCK_BRIDGE']       = row.lock_bridge;
                    arr['MINT_ADDRESS_MAX']  = row.mint_address_max;
                    arr['MINT_START_BLOCK']  = row.mint_start_block;
                    arr['MINT_STOP_BLOCK']   = row.mint_stop_block;
                    // build out token state
                    // TODO: will need to massage the data a bit more to build out accurate token state... this is quick and dirty
                    for(let key in arr){
                        let value = arr[key];
                        // Only set the ACTION_INDEX on the first valid issuance
                        if(key=='ACTION_INDEX' && this.util.isNull(data[key]))
                            data[key] = value;
                        // Disallow unsetting of LOCK flags
                        if(String(key).substr(0,5)=='LOCK_')
                            if(data[key]==1)
                                continue;
                        // Prevent changing decimal precision 
                        if(key=='DECIMALS' && data[key] > value)
                            continue;
                        // Skip setting value if value is null or empty (use last explicit value)
                        if(this.util.isNull(value) || value==='')
                            continue;
                        // Update data object with value from this ISSUE tx
                        data[key] = value;
                    }
                }
                // The `bridged` bit is NOT an issues field and is not replayed: it is a
                // tokens-table bit the first applied XBRIDGE v3 lock sets and nothing clears
                // in milestone 1, so it is current state read straight off the row rather
                // than folded across the issue history. Taken outside the loop above so the
                // empty-means-unchanged and lock rules there cannot touch it, and normalized
                // to 0/1 so a caller can compare it without knowing the column type.
                data['BRIDGED'] = (Number(results[0].bridged) === 1) ? 1 : 0;
            }
        }
        // Get token supply at the given action_index
        if(data)
            data['SUPPLY'] = await this.getTokenSupply(tick, block_index, action_index);
        return data;
    },

    // Handle getting decimal precision for a given tick_id
    async getTokenDecimalPrecision(tick_id){
        let decimals = 0;
        // Lookup decimal precision using the issues table 
        // DO NOT lookup precision using getTokenInfo() (avoid recursive queries)
        let query = `SELECT
                        i.decimals
                    FROM
                        issues i,
                        index_statuses s
                    WHERE
                        i.status_id=s.id AND
                        i.tick_id=? AND
                        s.status='valid'`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0){
            // Loop through ISSUE transactions for the given ticker
            for(let row of results){
                if(!this.util.isNull(row.decimals) && row.decimals > decimals)
                    decimals = row.decimals;
            }
        }
        // Clamp decimals to valid range [0, 18] to prevent SQL injection via DECIMAL CAST
        decimals = Math.max(0, Math.min(18, parseInt(decimals) || 0));
        return decimals;
    },

    // Create/Update record in `issues` table
    async createIssue(data){
        data                   = this.normalizeDataValues(data);
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
        let callback_tick_id   = await this.createTicker(data['CALLBACK_TICK']);
        let tick_id            = await this.createTicker(data['TICK']);
        let transfer_id        = await this.createAddress(data['TRANSFER']);
        let transfer_supply_id = await this.createAddress(data['TRANSFER_SUPPLY']);
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        // Check if record already exists for this ISSUE action
        let query = `SELECT action_index FROM issues WHERE action_index=?`;
        let args  = [action_index]
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
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
        } else {
            // INSERT record
            query = `INSERT INTO issues (
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
        }
        args    = [tick_id, max_supply, max_mint, decimals, description, mint_supply, transfer_id, transfer_supply_id, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, bridge_chains, min_depth, lock_bridge, memo_id, status_id, action_index ];
        results = await this.doQuery(query, args);
    },

    // Return the tick associated with an ISSUE action_index, or null if the
    // action_index does not resolve to a valid ISSUE. Used by LINK to decide
    // whether a linked action is targeting a TICK (and thus subject to the
    // owner / ownership-escrow rules).
    async getIssueTick(action_index){
        let query = `SELECT
                        t.tick
                    FROM
                        issues i
                        INNER JOIN index_tickers t ON (t.id=i.tick_id)
                        INNER JOIN index_statuses s ON (s.id=i.status_id)
                    WHERE
                        i.action_index=? AND
                        s.status='valid'
                    LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            return results[0].tick;
        return null;
    },

    // Get action_index of the first valid ISSUE action for a given ticker
    async getFirstIssueActionIndex(tick){
        let tick_id      = await this.createTicker(tick);
        let action_index = false;
        let query = `SELECT 
                        i.action_index 
                    FROM
                        issues i
                        INNER JOIN index_statuses s ON (s.id=i.status_id)
                    WHERE 
                        i.tick_id=? AND 
                        s.status='valid'
                    ORDER BY 
                        action_index ASC 
                    LIMIT 1`;
        let args = [tick_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            action_index = Number(results[0].action_index);
        return action_index;
    },

};

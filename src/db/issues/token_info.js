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
 * XChain Indexer - Database mixin part: issues / token_info
 *
 * The token state a tick resolves to, replayed from its valid ISSUE rows in action order.
 * Merged into the issues mixin by db/issues.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
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
            let query = issueReplay.rowsQuery(sql);
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                // Define data object
                if(!data)
                    data = {};
                // Loop through ISSUE transactions for the given ticker
                for(let row of results)
                    issueReplay.foldRow(this, data, issueReplay.rowValues(this, row, tick_id));
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

};

// The three steps of getTokenInfo's replay, kept off the exported object so
// Database.prototype gains no method: the statement over one tick's valid ISSUE rows,
// one row's values keyed as the token-info fields, and the fold of those values into
// the running token state.
const issueReplay = {

    // `sql` carries the optional block_index / action_index bounds, appended after the
    // tick_id filter so the caller's argument order matches the placeholders.
    rowsQuery(sql){
        return `SELECT 
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
    },

    rowValues(db, row, tick_id){
        // Define object of values for this ISSUE tx
        let arr  = {};
        arr['ACTION_INDEX']      = row.action_index;
        arr['TICK']              = row.tick;
        arr['TICK_ID']           = tick_id;
        arr['OWNER']             = (row.transfer) ? row.transfer : row.owner;
        arr['MAX_SUPPLY']        = row.max_supply;
        arr['MAX_MINT']          = row.max_mint;
        // Force decimal precision to a integer value
        arr['DECIMALS']          = (!db.util.isNull(row.decimals)) ? parseInt(row.decimals) : 0;
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
        return arr;
    },

    foldRow(db, data, arr){
        // build out token state
        // TODO: will need to massage the data a bit more to build out accurate token state... this is quick and dirty
        for(let key in arr){
            let value = arr[key];
            // Only set the ACTION_INDEX on the first valid issuance
            if(key=='ACTION_INDEX' && db.util.isNull(data[key]))
                data[key] = value;
            // Disallow unsetting of LOCK flags
            if(String(key).substr(0,5)=='LOCK_')
                if(data[key]==1)
                    continue;
            // Prevent changing decimal precision 
            if(key=='DECIMALS' && data[key] > value)
                continue;
            // Skip setting value if value is null or empty (use last explicit value)
            if(db.util.isNull(value) || value==='')
                continue;
            // Update data object with value from this ISSUE tx
            data[key] = value;
        }
    },

};

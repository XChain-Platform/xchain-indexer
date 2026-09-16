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
 * XChain Indexer - Database mixin part: actions / action_index
 *
 * The action_index row family: minting the next index, the probe-then-insert writer and
 * its update and delete, and the per-index reads (table, existence, type, confirmations).
 * Merged into the actions mixin by db/actions.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Handles returning the highest action_index from `actions` table
    async getNextActionIndex(){
        let idx   = 0;
        let query = "SELECT action_index FROM actions ORDER BY action_index DESC LIMIT 1";
        let results = await this.doQuery(query);
        if(results.length > 0)
            idx = Number(results[0].action_index);
        // Increase current action_index by 1 to get the next action_index
        idx++;
        return idx;
    },

    // Lookup action_index records in the `actions` table and return them
    async getActionIndex(data){
        let action_index  = null;
        let block_index   = data['BLOCK_INDEX'];
        let tx_index      = data['TX_INDEX'];
        let tx_vout       = data['TX_VOUT'];
        let action_format = data['FORMAT'];
        let action_id     = await this.createAction(data['ACTION']);
        let query = `SELECT
                        a.action_index
                    FROM
                        actions a
                    WHERE
                        a.block_index=? AND 
                        a.tx_index=? AND 
                        a.tx_vout=? AND
                        a.action_id=? AND
                        a.action_format=?`;
        let args = [block_index, tx_index, tx_vout, action_id, action_format];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            action_index = Number(results[0].action_index);
        return action_index;
    },

    // Create records in the 'actions' table and return record id
    async createActionIndex(data, force=false){
        // Set values to NULL if it is not already set. TX_VOUT is normalized here too so a
        // hub-mirror-injected action ({ ACTION, BLOCK_INDEX [, FORMAT] }) carries an explicit
        // null rather than leaking `undefined` into getActionIndex's args and the INSERT below,
        // where it only reached NULL via sqlstring's undefined->NULL coercion.
        data['BLOCK_INDEX'] = (!this.util.isNull(data['BLOCK_INDEX'])) ? data['BLOCK_INDEX'] : null;
        data['TX_INDEX']    = (!this.util.isNull(data['TX_INDEX'])) ? data['TX_INDEX'] : null;
        data['TX_VOUT']     = (!this.util.isNull(data['TX_VOUT'])) ? data['TX_VOUT'] : null;
        data['FORMAT']      = (!this.util.isNull(data['FORMAT'])) ? data['FORMAT'] : null;
        // Check if the action index already exists. LOAD-BEARING NULL-blindness: for
        // synthetic/injected rows block_index/tx_index/tx_vout are NULL, and SQL `col = NULL`
        // matches nothing, so this probe never fires and every injected CROSS_SETTLE / XEXEC /
        // XCALL mints a FRESH action_index (required - multiple per block must not collapse into
        // one). Do NOT "harden" the getActionIndex predicate to NULL-safe `<=>`: that would merge
        // same-block injections into one action_index and corrupt settlement.
        let action_index = await this.getActionIndex(data);
        // Handle creating record
        if(action_index==null || force==true){
            action_index      = await this.getNextActionIndex();
            let block_index   = data['BLOCK_INDEX'];
            let tx_index      = data['TX_INDEX'];
            let tx_vout       = data['TX_VOUT'];
            let action_format = data['FORMAT'];
            let action_id     = await this.createAction(data['ACTION']);
            // Persist the action's TRUE source so it is never re-derived from the transaction.
            // For user actions this is the tx sender (identical to transactions.source_id); for
            // contract emissions it is the contract's derived address (the caller's EXECUTE tx
            // would otherwise mis-attribute it). createAddress returns null for null/undefined,
            // so system/synthetic actions (which pass no SOURCE) store NULL.
            let source_id     = await this.createAddress(data['SOURCE']);
            let query         = "INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) values (?, ?, ?, ?, ?, ?, ?)";
            let args          = [action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id];
            let results       = await this.doQuery(query, args);
        }
        return action_index;
    },

    // Update records in the 'actions' table and return record id
    async updateActionIndex(action_index, action){
        if(action_index){
            let action_id = await this.createAction(action);
            let query     = "UPDATE actions SET action_id=? WHERE action_index=?";
            let args      = [action_id, action_index];
            let results   = await this.doQuery(query, args);
        }
    },

    // Delete records in the 'actions' table
    async deleteActionIndex(action_index){
        if(action_index){
            let query   = "DELETE FROM actions WHERE action_index=?";
            let args    = [action_index];
            let results = await this.doQuery(query, args);
        }
    },

    // Lookup table associated with an action
    async getActionIndexTable(action_index){
        let table  = null;
        let query  = `SELECT 
                        LCASE(a2.action) as action
                    FROM 
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?
                    LIMIT 1`;
        let args   = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            let action = results[0].action;
            if(['address','batch','dispense'].includes(action)){
                table = action + 'es';
            } else {
                table = action + 's';
            }
        }
        return table;
    },

    // Finalized cross-chain matches that involve THIS chain, are effective at/before
    // block_time, and have not yet been settled locally. Drives the settlement pass.
    // cross_chain_matches is a hub-mirrored table (read via mirrorDb), while
    // cross_chain_settlements is a local indexer table (read via this) - so we filter in JS
    // rather than join across two databases.
    //
    // Capped per block, mirroring getEffectiveUndispatchedCalls (overflow carries
    // forward; never dropped). Without it a hub backlog injected an unbounded number
    // of escrow-releasing CROSS_SETTLE actions into one block transaction.
    // The slice lands AFTER the settled-set exclusion so the cap counts real work, and
    // the ORDER BY above is a total order on quorum-agreed content, so every operator
    // takes the identical prefix. See CROSS_SETTLE_MAX_PER_BLOCK in protocol/constants.js
    // for why the cap is consensus-visible and why it lands behind the
    // CROSS_SETTLE_PER_BLOCK_CAP flag day (operator ruling of 2026-08-11).
    //
    // The `limit` is the CALLER's decision because that caller (processCrossChainSettlements)
    // is the one holding the block index the flag day is evaluated against: it passes the
    // protocol cap once the gate is on, and MAX_SAFE_INTEGER before, which is the legacy
    // uncapped pass. This method never evaluates the gate itself, so it can never disagree
    // with the caller about which side of the flag day a block is on.
    // Whether an action index has been parsed on this chain (a row in `actions`), as of the
    // current parse height. CROSS_SETTLE uses it to tell a local leg the replay has not
    // reached yet (retry on a later block) from one that is indexed and is not an offer
    // (never settles). Read-only; no consensus row depends on it.
    async isActionIndexParsed(actionIndex){
        let rows = await this.doQuery('SELECT 1 AS present FROM actions WHERE action_index = ? LIMIT 1', [actionIndex]);
        return rows.length > 0;
    },

    // Get existence + block height + type for a given action_index. Serves the
    // getactionconfirmations API method, which lets the xchain-hub federation
    // confirm that a proposed cross-chain source action really exists on this
    // chain (and at what depth) before co-signing an attestation.
    async getActionInfo(action_index){
        let args = [action_index];
        let sql  = `SELECT
                        a1.action_index,
                        a1.block_index,
                        a2.action
                    FROM
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(sql, args);
        return (results && results.length) ? results[0] : null;
    },

    // Get action type for a given action_index
    async getActionType(action_index){
        let type = null;
        // Lookup the ACTION based on the action_index
        let args = [action_index];
        let sql  = `SELECT 
                        a2.action
                    FROM
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?`;
        let results = await this.doQuery(sql, args);
        if(results && results.length)
            type = results[0].action;
        return type;
    },

};

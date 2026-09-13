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
 * XChain Indexer - Database mixin: lists
 * 
 * The queries over the lists table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
const listEditResolution = require('../list_edit_resolution_activation');

module.exports = {

    // Return a list type given a tx_hash
    async getListType(action_index){
        let type  = false;
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            let query = "SELECT type FROM lists WHERE action_index=? LIMIT 1";
            let args  = [action_index];
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                type = parseInt(results[0].type);

        }
        return type;
    },

    // Walk a LIST reference up to the CREATE action that roots its edit chain.
    // An edit row carries the index of the list it edits in lists.list_action_index;
    // a create row carries NULL. Post-flag-day list.js normalizes every edit to
    // point straight at the root, so this is a single hop in practice; the bounded
    // loop covers legacy rows that named another edit (and can never spin on a
    // cycle, which a malformed chain could otherwise produce).
    // @param {action_index}  integer  ACTION_INDEX of any LIST create or edit
    async getListRootIndex(action_index){
        let root = action_index;
        let seen = {};
        for(let hop = 0; hop < 16; hop++){
            if(seen[String(root)]) break;
            seen[String(root)] = true;
            let rows = await this.doQuery("SELECT list_action_index FROM lists WHERE action_index=? LIMIT 1", [root]);
            if(rows.length == 0) break;
            let parent = rows[0]['list_action_index'];
            if(this.util.isNull(parent)) break;
            root = parent;
        }
        return root;
    },

    // Resolve a LIST reference to the action whose list_items rows ARE the list's
    // CURRENT membership: the newest VALID action in its edit chain, or the create
    // itself when it has no valid edits. Every valid edit persists a COMPLETE
    // membership snapshot (list.js splices the final item array and writes all of
    // it), so the head's rows are the whole list, never a delta. Ordering is by
    // action_index DESC, a total order (action_index is unique and monotonic), so
    // independently-built nodes resolve the same head. Invalid edits are excluded:
    // they write no list_items rows at all, so picking one would empty the list.
    // @param {action_index}  integer  ACTION_INDEX of any LIST create or edit
    async getListHeadIndex(action_index){
        let root = await this.getListRootIndex(action_index);
        let query = `SELECT
                        l.action_index
                    FROM
                        lists l
                        INNER JOIN index_statuses s ON (s.id=l.status_id)
                    WHERE
                        l.list_action_index=?
                        AND s.status='valid'
                    ORDER BY l.action_index DESC
                    LIMIT 1`;
        let rows = await this.doQuery(query, [root]);
        return (rows.length > 0) ? rows[0]['action_index'] : root;
    },

    // Return a list given a tx_hash
    // @param {action_index}  integer  ACTION_INDEX of a LIST (as pinned by consumers)
    // @param {block_index}   integer  block being processed; gates edit resolution
    async getList(action_index, block_index){
        let type = await this.getListType(action_index);
        let list = [];
        if(type){
            // a LIST edit writes its resulting items under the EDIT's own
            // action_index and never touches the parent's rows, so reading the
            // pinned (create) index returned create-time membership forever and
            // on-chain lists were immutable. Resolve the edit chain's head
            // instead. Flag-day gated per chain (list_edit_resolution_activation.js)
            // because it changes which actions the allow/block gates accept, hence
            // historical replay; below the height (or with no block context) the
            // legacy create-index read runs unchanged.
            let resolved = action_index;
            if(listEditResolution.isListEditResolutionActive(block_index, this.config['NETWORK'], this.config['COIN']))
                resolved = await this.getListHeadIndex(action_index);
            let query = '';
            let args  = [resolved];
            // CONSENSUS: list_items has no ORDER BY on the AUTO_INCREMENT insert
            // order, so the row order MariaDB returns is engine/plan-arbitrary. The
            // consuming AIRDROP recipient loop (airdrop.js) builds credits in this
            // order, so an unordered list makes the credit-insert order (and any
            // order-sensitive step) diverge across independently-built nodes. Pin a
            // deterministic total order on the resolved item string with a BINARY
            // collation, mirroring the getHolders/getBlockHashes hardening
            // (index_addresses is utf8_general_ci = case/accent-folding). Duplicate
            // items resolve to byte-identical strings, so the ordering is total for
            // consensus purposes (a tie is byte-identical and the consumer dedups).
            // Left UNGATED, mirroring getHolders' own ungated sort: the ledger hash is
            // invariant to this order because getBlockHashes re-sorts credits on the
            // resolved (address, tick, amount) columns and never hashes a surrogate
            // id, so ordered and unordered produce byte-identical block hashes; this
            // removes the engine-order dependency at the source (3c05dcb9).
            if(type==1){
                query = `SELECT
                            t.tick as item
                        FROM
                            list_items l
                            INNER JOIN index_tickers t ON (l.item_id=t.id)
                        WHERE
                            l.action_index=?
                        ORDER BY t.tick COLLATE utf8mb4_bin ASC`;
            }
            if(type==2){
                query = `SELECT
                            a.address as item
                        FROM
                            list_items l
                            INNER JOIN index_addresses a ON (l.item_id=a.id)
                        WHERE
                            l.action_index=?
                        ORDER BY a.address COLLATE utf8_bin ASC`;
            }
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                for(let row of results)
                    list.push(row['item']);
        }
        return list;
    },

    // "As of a block" variant of getList (the token bridge policy spec
    // section 3, D3). getList/getListHeadIndex answer CURRENT state (ORDER BY
    // action_index DESC LIMIT 1, no bound), which is wrong for gettokenpolicy reading a
    // token's policy at a past origin_block: the head must be bounded to the last action
    // index AT that block, not this chain's own tip. Read-path only: this never enters
    // isActionAllowed, so no consensus verdict moves.
    // @param {action_index}  integer  ACTION_INDEX of a LIST (as pinned by consumers)
    // @param {block_index}   integer  the height to resolve the list's membership AS OF
    async getListAtBlock(action_index, block_index){
        let type = await this.getListType(action_index);
        let list = [];
        if(type){
            let root     = await this.getListRootIndex(action_index);
            let resolved = root;
            // Same activation gate as getList: below it (or with no block context) the
            // legacy create-index membership stands, which is already immutable and needs
            // no bound.
            if(this.isListEditResolutionActive(block_index)){
                let headQuery = `SELECT
                                    l.action_index
                                FROM
                                    lists l
                                    INNER JOIN index_statuses s ON (s.id=l.status_id)
                                    INNER JOIN actions        a ON (a.action_index=l.action_index)
                                WHERE
                                    l.list_action_index=?
                                    AND s.status='valid'
                                    AND a.block_index<=?
                                ORDER BY l.action_index DESC
                                LIMIT 1`;
                let headRows = await this.doQuery(headQuery, [root, block_index]);
                resolved = (headRows.length > 0) ? headRows[0]['action_index'] : root;
            }
            let query = '';
            let args  = [resolved];
            // Same deterministic total order as getList (see its comment for why the
            // BINARY collation is load-bearing there); harmless repetition here since this
            // read never feeds a hash.
            if(type==1){
                query = `SELECT
                            t.tick as item
                        FROM
                            list_items l
                            INNER JOIN index_tickers t ON (l.item_id=t.id)
                        WHERE
                            l.action_index=?
                        ORDER BY t.tick COLLATE utf8mb4_bin ASC`;
            }
            if(type==2){
                query = `SELECT
                            a.address as item
                        FROM
                            list_items l
                            INNER JOIN index_addresses a ON (l.item_id=a.id)
                        WHERE
                            l.action_index=?
                        ORDER BY a.address COLLATE utf8_bin ASC`;
            }
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                for(let row of results)
                    list.push(row['item']);
        }
        return list;
    },

    // Create record in `lists` table
    async createList(data){
        data                  = this.normalizeDataValues(data);
        let action_index      = data['ACTION_INDEX'];
        let status_id         = await this.createStatus(data['STATUS']);
        let list_type         = data['TYPE'];
        let list_edit         = data['EDIT'];
        let list_action_index = data['LIST_ACTION_INDEX'];
        // LIST carries an optional MEMO like every other action; createMemo returns
        // NULL for an absent one, which is also what a pre-MEMO list row holds, so
        // the two are indistinguishable and there is nothing to backfill.
        let memo_id           = await this.createMemo(data['MEMO']);
        // Check if record already exists for this token
        let query  = "SELECT action_index FROM lists WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                            lists
                        SET
                            type=?,
                            edit=?,
                            list_action_index=?,
                            memo_id=?,
                            status_id=?
                        WHERE
                            action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO lists (type, edit, list_action_index, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [list_type, list_edit, list_action_index, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

    // Resolve the SOURCE address of a LIST action (the address that broadcast it). Used by
    // list.js for the two edit-authorization rules: the unconditional refusal of a broadcast
    // edit of a bridge-owned list, and the flag-gated owner check that requires an editor to
    // be the address that created the list. Returns null when the action is not a LIST or
    // its source cannot be resolved, which both callers treat as "no claim proven".
    // @param {action_index}  integer  ACTION_INDEX of a LIST create or edit
    async getListSource(action_index){
        if(this.util.isNull(action_index) || !this.util.isNumeric(action_index))
            return null;
        let query = `SELECT
                        a2.address AS address
                    FROM
                        lists l
                        INNER JOIN actions         a1 ON (a1.action_index=l.action_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                    WHERE
                        l.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        return (results.length > 0) ? results[0]['address'] : null;
    },

    // Create record in `list_edits` table
    async createListEdit(data, item, status){
        let action_index = data['ACTION_INDEX'];
        let status_id = await this.createStatus(status);
        let item_id   = null;
        if(data['TYPE']==1)
            item_id = await this.createTicker(item);
        if(data['TYPE']==2)
            item_id = await this.createAddress(item);
        // Check if record already exists for this list
        let query  = "SELECT item_id FROM list_edits WHERE action_index=? AND item_id=? AND status_id=? LIMIT 1";
        let args   = [action_index, item_id, status_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_edits (action_index, item_id, status_id) values (?, ?, ?)";
            results = await this.doQuery(query, args);
        }
    },

    // Create record in `list_items` table
    async createListItem(data, item){
        let action_index = data['ACTION_INDEX'];
        let item_id      = null;
        if(data['TYPE']==1)
            item_id = await this.createTicker(item);
        if(data['TYPE']==2)
            item_id = await this.createAddress(item);
        // Check if record already exists for this list
        let query  = "SELECT item_id FROM list_items WHERE action_index=? AND item_id=? LIMIT 1";
        let args   = [action_index, item_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_items (action_index, item_id) values (?, ?)";
            results = await this.doQuery(query, args);
        }
    },

    // Create record in `list_items_invalid` table
    async createListItemInvalid(data, item, status){
        let action_index = data['ACTION_INDEX'];
        let status_id    = await this.createStatus(status);
        let item_id      = null;
        if(data['TYPE']==1)
            item_id = await this.createTicker(item);
        if(data['TYPE']==2)
            item_id = await this.createAddress(item);
        // Check if record already exists for this list
        let query  = "SELECT item_id FROM list_items_invalid WHERE action_index=? AND item_id=? AND status_id=? LIMIT 1";
        let args   = [action_index, item_id, status_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_items_invalid (action_index, item_id, status_id) values (?, ?, ?)";
            results = await this.doQuery(query, args);
        }
    },

};

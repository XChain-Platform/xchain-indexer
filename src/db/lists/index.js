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
// The list-edit resolution flag day is a registry row read by literal key (W5), keyed
// '<COIN>:<network>' so the coin goes with the height.
const gateRegistry = require('../../consensus/gate_registry');
const { getListHeadIndex } = require('./head_resolution');
const { listItemId } = require('./membership');
const { getUnionResolution, readUnionMembers } = require('./union');
const LIST_EDIT_RESOLUTION_KEY = 'list_edit_resolution_activation.LIST_EDIT_RESOLUTION_ACTIVATION';
const LIST_REFERENCE_VALIDITY_KEY = 'list_reference_validity_activation.LIST_REFERENCE_REQUIRES_VALID_LIST';
// Rows per multi-row INSERT, so a large membership never builds an unbounded statement.
const LIST_BULK_INSERT_CHUNK = 500;
const LIST_BULK_TABLES = {
    list_edits: { withStatus: true, select: 'SELECT item_id FROM list_edits WHERE action_index=? AND status_id=?', insert: 'INSERT INTO list_edits (action_index, item_id, status_id) values ' },
    list_items: { withStatus: false, select: 'SELECT item_id FROM list_items WHERE action_index=?', insert: 'INSERT INTO list_items (action_index, item_id) values ' },
    list_items_invalid: { withStatus: true, select: 'SELECT item_id FROM list_items_invalid WHERE action_index=? AND status_id=?', insert: 'INSERT INTO list_items_invalid (action_index, item_id, status_id) values ' },
};

// Resolve an item => status map to [item_id, status_id] tuples in input order.
async function statusRows(db, data, byItem){
    let rows = [];
    for(let item in byItem){
        let status_id = await db.createStatus(byItem[item]);
        rows.push([await listItemId(db, data['TYPE'], item), status_id]);
    }
    return rows;
}

// Insert row tuples with one statement per chunk. A null item_id never matches an
// existing row, mirroring the per-row lookup it replaces, so those rows always insert.
async function bulkInsertListRows(db, table, action_index, rows){
    let spec = LIST_BULK_TABLES[table];
    if(rows.length === 0)
        return;
    let seen = new Set();
    let statuses = spec.withStatus ? [...new Set(rows.map((row) => row[1]))] : [null];
    for(let status of statuses){
        let existing = await db.doQuery(spec.select, status === null ? [action_index] : [action_index, status]);
        for(let row of existing)
            seen.add(`${row['item_id']}|${status}`);
    }
    let fresh = rows.filter((row) => {
        let key = `${row[0]}|${row[1] ?? null}`;
        if(row[0] === null || row[0] === undefined)
            return true;
        return !seen.has(key) && seen.add(key);
    });
    let marks = '(' + new Array(spec.withStatus ? 3 : 2).fill('?').join(', ') + ')';
    for(let i = 0; i < fresh.length; i += LIST_BULK_INSERT_CHUNK){
        let chunk = fresh.slice(i, i + LIST_BULK_INSERT_CHUNK);
        let args = chunk.flatMap((row) => [action_index, ...row]);
        await db.doQuery(spec.insert + chunk.map(() => marks).join(', '), args);
    }
}

// Distinguish a stored LIST rejected by the validity gate from an unknown id.
// Policy readers treat the rejected reference as absent, while unknown getList
// lookups retain their empty-array contract.
async function isRejectedListReference(db, action_index, block_index){
    if(db.util.isNull(action_index) || !db.util.isNumeric(action_index))
        return false;
    if(!gateRegistry.activeAt(LIST_REFERENCE_VALIDITY_KEY, db.config['NETWORK'], db.config['COIN'], block_index, null))
        return false;
    let rows = await db.doQuery("SELECT type FROM lists WHERE action_index=? LIMIT 1", [action_index]);
    return rows.length > 0;
}

// a LIST edit writes its resulting items under the EDIT's own
// action_index and never touches the parent's rows, so reading the
// pinned (create) index returned create-time membership forever and
// on-chain lists were immutable. Resolve the edit chain's head
// instead. Flag-day gated per chain (list_edit_resolution_activation.js)
// because it changes which actions the allow/block gates accept, hence
// historical replay; below the height (or with no block context) the
// legacy create-index read runs unchanged.
async function resolveListReadIndex(db, action_index, block_index){
    if(gateRegistry.activeAt(LIST_EDIT_RESOLUTION_KEY, db.config['NETWORK'], db.config['COIN'], block_index, null))
        return db.getListHeadIndex(action_index, block_index);
    return action_index;
}

async function queryListMembers(db, type, resolved){
    let query = '';
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
    let results = await db.doQuery(query, [resolved]);
    return results.map(row => row['item']);
}

module.exports = {

    getListHeadIndex,

    // Return a list type given an action index. Once the validity gate is active,
    // only a LIST action with a valid verdict can supply a reference type.
    async getListType(action_index, block_index, resolution=null){
        let getStoredType = this.getListStoredType || module.exports.getListStoredType;
        let storedType = await getStoredType.call(this, action_index, block_index);
        let union = await getUnionResolution(this, action_index, storedType, block_index);
        if(union){
            if(resolution)
                resolution.union = union;
            return union.memberType;
        }
        return storedType;
    },

    async getListStoredType(action_index, block_index){
        let type  = false;
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            let query = "SELECT type FROM lists WHERE action_index=? LIMIT 1";
            if(gateRegistry.activeAt(LIST_REFERENCE_VALIDITY_KEY, this.config['NETWORK'], this.config['COIN'], block_index, null))
                query = `SELECT l.type
                         FROM lists l
                         INNER JOIN index_statuses s ON (s.id=l.status_id)
                         WHERE l.action_index=? AND s.status='valid'
                         LIMIT 1`;
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
    // point straight at the root, so this is a single hop in practice. The default
    // bound preserves legacy reads; gated head resolution can request a complete
    // walk, with cycle detection bounding malformed chains. A block ceiling only
    // extends a capped walk when its candidate is newer than that ceiling.
    // @param {action_index}  integer  ACTION_INDEX of any LIST create or edit
    // @param {max_hops}  integer|null  ordinary parent-walk limit
    // @param {max_block_index} integer|null candidate block-height ceiling
    async getListRootIndex(action_index, max_hops=16, max_block_index=null){
        let root = action_index;
        let seen = {};
        let hop = 0;
        while(max_hops===null || hop < max_hops){
            if(seen[String(root)]) break;
            seen[String(root)] = true;
            let rows = await this.doQuery("SELECT list_action_index FROM lists WHERE action_index=? LIMIT 1", [root]);
            if(rows.length == 0) break;
            let parent = rows[0]['list_action_index'];
            if(this.util.isNull(parent)) break;
            root = parent;
            hop++;
        }
        if(!this.util.isNull(max_block_index)){
            let boundedSeen = {};
            while(!boundedSeen[String(root)]){
                boundedSeen[String(root)] = true;
                let query = `SELECT
                                l.list_action_index
                            FROM
                                lists l
                                INNER JOIN actions a ON (a.action_index=l.action_index)
                            WHERE
                                l.action_index=?
                                AND a.block_index>?
                            LIMIT 1`;
                let rows = await this.doQuery(query, [root, max_block_index]);
                if(rows.length == 0) break;
                let parent = rows[0]['list_action_index'];
                if(this.util.isNull(parent)) break;
                root = parent;
            }
        }
        return root;
    },

    // Return a list given an action index, or null for a stored reference rejected
    // by the active validity gate.
    // @param {action_index}  integer  ACTION_INDEX of a LIST (as pinned by consumers)
    // @param {block_index}   integer  block being processed; gates edit resolution
    async getList(action_index, block_index){
        let resolution = {};
        let type = await this.getListType(action_index, block_index, resolution);
        if(!type && await isRejectedListReference(this, action_index, block_index))
            return null;
        if(!type)
            return [];
        let resolved = await resolveListReadIndex(this, action_index, block_index);
        if(resolution.union)
            return readUnionMembers(this, resolved, block_index, false);
        return queryListMembers(this, type, resolved);
    },

    // "As of a block" variant of getList (the token bridge policy spec
    // section 3, D3). getList/getListHeadIndex answer CURRENT state (ORDER BY
    // action_index DESC LIMIT 1, no bound), which is wrong for gettokenpolicy reading a
    // token's policy at a past origin_block: the head must be bounded to the last action
    // index AT that block, not this chain's own tip. Read-path only: this never enters
    // isActionAllowed, so no consensus verdict moves.
    // May return null when the active validity gate rejects a stored LIST reference.
    // @param {action_index}  integer  ACTION_INDEX of a LIST (as pinned by consumers)
    // @param {block_index}   integer  the height to resolve the list's membership AS OF
    async getListAtBlock(action_index, block_index){
        let resolution = {};
        let type = await this.getListType(action_index, block_index, resolution);
        if(!type && await isRejectedListReference(this, action_index, block_index))
            return null;
        let list = [];
        if(type){
            let resolved = action_index;
            // Same activation gate as getList: below it (or with no block context) the
            // legacy create-index membership stands, which is already immutable and needs
            // no bound.
            if(this.isListEditResolutionActive(block_index)){
                resolved = await this.getListHeadIndex(action_index, block_index, block_index);
            }
            if(resolution.union)
                return readUnionMembers(this, resolved, block_index, true);
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

    async createListEdit(data, item, status){
        await this.createListEdits(data, { [item]: status });
    },

    async createListItem(data, item){
        await this.createListItems(data, [item]);
    },

    async createListItemInvalid(data, item, status){
        await this.createListItemsInvalid(data, { [item]: status });
    },

    // Bulk writers: ids resolve in input order, then rows insert in bounded chunks.
    async createListEdits(data, edit){
        await bulkInsertListRows(this, 'list_edits', data['ACTION_INDEX'],
            await statusRows(this, data, edit));
    },

    async createListItems(data, items){
        let rows = [];
        for(let item of items)
            rows.push([await listItemId(this, data['TYPE'], item)]);
        await bulkInsertListRows(this, 'list_items', data['ACTION_INDEX'], rows);
    },

    async createListItemsInvalid(data, invalid){
        await bulkInsertListRows(this, 'list_items_invalid', data['ACTION_INDEX'],
            await statusRows(this, data, invalid));
    },

};

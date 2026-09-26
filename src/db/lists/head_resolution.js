/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Resolves the current action at the head of a LIST edit chain.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');

const LIST_HEAD_FOLLOWS_EDIT_CHAIN_KEY = 'list_head_follows_edit_chain.LIST_HEAD_FOLLOWS_EDIT_CHAIN';

// Build the child lookup with an optional block-height ceiling.
function childQuery(db, parent, max_block_index){
    if(db.util.isNull(max_block_index)){
        return {
            query: `SELECT
                        l.action_index,
                        s.status
                    FROM
                        lists l
                        INNER JOIN index_statuses s ON (s.id=l.status_id)
                    WHERE
                        l.list_action_index=?
                    ORDER BY l.action_index DESC`,
            args: [parent]
        };
    }
    return {
        query: `SELECT
                    l.action_index,
                    s.status
                FROM
                    lists l
                    INNER JOIN index_statuses s ON (s.id=l.status_id)
                    INNER JOIN actions        a ON (a.action_index=l.action_index)
                WHERE
                    l.list_action_index=?
                    AND a.block_index<=?
                ORDER BY l.action_index DESC`,
        args: [parent, max_block_index]
    };
}

// Follow every reachable edit while bounding malformed cycles.
async function followEditChain(db, root, max_block_index){
    let head = root;
    let pending = [root];
    let seen = { [String(root)]: true };
    while(pending.length > 0){
        let parent = pending.shift();
        let { query, args } = childQuery(db, parent, max_block_index);
        let children = await db.doQuery(query, args);
        for(let child of children){
            let childIndex = child['action_index'];
            let childKey = String(childIndex);
            if(seen[childKey]) continue;
            seen[childKey] = true;
            pending.push(childIndex);
            if(child['status']=='valid' && Number(childIndex) > Number(head))
                head = childIndex;
        }
    }
    return head;
}

// Preserve the direct-child lookup used below activation.
async function directChildHead(db, root, max_block_index){
    let blockJoin = '';
    let blockWhere = '';
    let args = [root];
    if(!db.util.isNull(max_block_index)){
        blockJoin = 'INNER JOIN actions a ON (a.action_index=l.action_index)';
        blockWhere = 'AND a.block_index<=?';
        args.push(max_block_index);
    }
    let query = `SELECT
                    l.action_index
                FROM
                    lists l
                    INNER JOIN index_statuses s ON (s.id=l.status_id)
                    ${blockJoin}
                WHERE
                    l.list_action_index=?
                    AND s.status='valid'
                    ${blockWhere}
                ORDER BY l.action_index DESC
                LIMIT 1`;
    let rows = await db.doQuery(query, args);
    return (rows.length > 0) ? rows[0]['action_index'] : root;
}

// Resolve a LIST reference to the action whose list_items rows ARE the list's
// CURRENT membership: the newest VALID action in its edit chain, or the create
// itself when it has no valid edits. Every valid edit persists a COMPLETE
// membership snapshot (list.js splices the final item array and writes all of
// it), so the head's rows are the whole list, never a delta. Ordering is by
// action_index DESC, a total order (action_index is unique and monotonic), so
// independently-built nodes resolve the same head. Invalid edits are excluded:
// they write no list_items rows at all, so picking one would empty the list.
// @param {action_index}  integer  ACTION_INDEX of any LIST create or edit
async function getListHeadIndex(action_index, block_index, max_block_index=null){
    let followsEditChain = gateRegistry.activeAt(LIST_HEAD_FOLLOWS_EDIT_CHAIN_KEY,
        this.config['NETWORK'], this.config['COIN'], block_index, null);
    // A complete root walk belongs to the same gate as complete descendant
    // traversal. The default bound keeps below-gate replay behavior unchanged.
    let root = await this.getListRootIndex(action_index, followsEditChain ? null : 16);
    if(followsEditChain)
        return followEditChain(this, root, max_block_index);
    return directChildHead(this, root, max_block_index);
}

module.exports = { getListHeadIndex };

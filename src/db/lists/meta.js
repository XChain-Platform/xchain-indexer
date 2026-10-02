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
 ********************************************************************/

'use strict';

async function createListMeta(data, name, description){
    data = this.normalizeDataValues(data);
    let actionIndex = data['ACTION_INDEX'];
    let listActionIndex = data['LIST_ACTION_INDEX'];
    let statusId = await this.createStatus(data['STATUS']);
    let memoId = await this.createMemo(data['MEMO']);
    let rows = await this.doQuery(
        'SELECT action_index FROM list_metas WHERE action_index=? LIMIT 1',
        [actionIndex]
    );
    let query;
    if(rows.length > 0){
        query = `UPDATE list_metas
                 SET list_action_index=?, name=?, description=?, memo_id=?, status_id=?
                 WHERE action_index=?`;
    } else {
        query = `INSERT INTO list_metas
                    (list_action_index, name, description, memo_id, status_id, action_index)
                 VALUES (?, ?, ?, ?, ?, ?)`;
    }
    return await this.doQuery(query, [
        listActionIndex, name, description, memoId, statusId, actionIndex
    ]);
}

async function getListMeta(db, rootIndex, blockIndex){
    if(!db || typeof db.doQuery !== 'function'){
        blockIndex = rootIndex;
        rootIndex = db;
        db = this;
    }
    let blockClause = '';
    let args = [rootIndex];
    if(blockIndex !== null && blockIndex !== undefined){
        blockClause = 'AND a.block_index<=?';
        args.push(blockIndex);
    }
    let rows = await db.doQuery(
        `SELECT lm.name, lm.description
         FROM list_metas lm
         INNER JOIN actions a ON (a.action_index=lm.action_index)
         INNER JOIN index_statuses s ON (s.id=lm.status_id)
         WHERE lm.list_action_index=?
           AND s.status='valid'
           ${blockClause}
         ORDER BY lm.action_index DESC
         LIMIT 1`,
        args
    );
    return rows.length > 0 ? rows[0] : null;
}

module.exports = { createListMeta, getListMeta };

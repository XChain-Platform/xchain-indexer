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
 **********************************************************************/

'use strict';

async function isListShared(db, rootIndex){
    let rows = await db.doQuery(
        `SELECT 1
         FROM lists l
         INNER JOIN actions a ON (a.action_index=l.action_index)
         INNER JOIN index_statuses s ON (s.id=l.status_id)
         WHERE l.list_action_index=?
           AND a.action_format=2
           AND s.status='valid'
         LIMIT 1`,
        [rootIndex]
    );
    return rows.length > 0;
}

async function getSharedLists(db){
    return await db.doQuery(
        `SELECT
            l.list_action_index AS root_index,
            l.action_index AS share_action_index,
            a.block_index AS share_block
         FROM lists l
         INNER JOIN actions a ON (a.action_index=l.action_index)
         INNER JOIN index_statuses s ON (s.id=l.status_id)
         WHERE a.action_format=2
           AND s.status='valid'
         ORDER BY l.action_index ASC`,
        []
    );
}

async function getSharedListDetails(db){
    return await db.doQuery(
        `SELECT
            l.list_action_index AS root_index,
            l.action_index AS share_action_index,
            a.block_index AS share_block,
            (SELECT lm.name
               FROM list_metas lm
               INNER JOIN index_statuses ms ON (ms.id=lm.status_id)
              WHERE lm.list_action_index=l.list_action_index
                AND ms.status='valid'
              ORDER BY lm.action_index DESC
              LIMIT 1) AS name,
            CASE WHEN EXISTS (
                SELECT 1
                  FROM list_transfers lt
                  INNER JOIN index_addresses ta ON (ta.id=lt.destination_id)
                 WHERE lt.list_action_index=l.list_action_index
            ) THEN (
                SELECT ta.address
                  FROM list_transfers lt
                  INNER JOIN index_addresses ta ON (ta.id=lt.destination_id)
                 WHERE lt.list_action_index=l.list_action_index
                 ORDER BY lt.action_index DESC
                 LIMIT 1
            ) ELSE (
                SELECT sa.address
                  FROM lists root
                  INNER JOIN actions root_action ON (root_action.action_index=root.action_index)
                  INNER JOIN index_addresses sa ON (sa.id=root_action.source_id)
                 WHERE root.action_index=l.list_action_index
                 LIMIT 1
            ) END AS owner
         FROM lists l
         INNER JOIN actions a ON (a.action_index=l.action_index)
         INNER JOIN index_statuses s ON (s.id=l.status_id)
         WHERE a.action_format=2
           AND s.status='valid'
         ORDER BY l.action_index ASC`,
        []
    );
}

async function getListOwner(db, rootIndex){
    let rows = await db.doQuery(
        `SELECT a.address
         FROM list_transfers lt
         INNER JOIN index_addresses a ON (a.id=lt.destination_id)
         WHERE lt.list_action_index=?
         ORDER BY lt.action_index DESC
         LIMIT 1`,
        [rootIndex]
    );
    if(rows.length > 0)
        return rows[0].address;
    return await db.getListSource(rootIndex);
}

async function createListTransfer(db, data, destination){
    let destinationId = await db.createAddress(destination);
    return await db.doQuery(
        `INSERT INTO list_transfers
            (action_index, list_action_index, destination_id)
         VALUES (?, ?, ?)`,
        [data['ACTION_INDEX'], data['LIST_ACTION_INDEX'], destinationId]
    );
}

module.exports = {
    isListShared,
    getSharedLists,
    getSharedListDetails,
    getListOwner,
    createListTransfer
};

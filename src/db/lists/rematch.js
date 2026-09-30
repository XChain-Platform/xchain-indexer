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
 * Open market lookups used when a list changes.
 *
 ********************************************************************/

'use strict';

function listReferenceSql(alias){
    return `(${alias}.allow_list=? OR
             ${alias}.block_list=? OR
             ${alias}.allow_list IN (SELECT action_index FROM lists WHERE list_action_index=?) OR
             ${alias}.block_list IN (SELECT action_index FROM lists WHERE list_action_index=?))`;
}

function candidateSql(kind){
    let table = kind + 's';
    let edits = kind + '_edits';
    let statuses = kind + '_statuses';
    let marketAlias = kind.charAt(0);
    let editAlias = marketAlias + 'e';
    let statusAlias = marketAlias + 's';
    let marketKey = kind + '_action_index';
    return `SELECT DISTINCT
                    ${marketAlias}.action_index,
                    ${marketAlias}.allow_list,
                    ${marketAlias}.block_list
                FROM
                    ${table} ${marketAlias}
                    INNER JOIN ${statuses} ${statusAlias} ON (${statusAlias}.${marketKey}=${marketAlias}.action_index)
                    INNER JOIN index_statuses st ON (st.id=${statusAlias}.status_id)
                WHERE
                    ${statusAlias}.action_index = (
                        SELECT MAX(latest.action_index)
                        FROM ${statuses} latest
                        WHERE latest.${marketKey}=${marketAlias}.action_index
                    ) AND
                    st.status='open' AND
                    (
                        ${listReferenceSql(marketAlias)} OR
                        EXISTS (
                            SELECT 1
                            FROM ${edits} ${editAlias}
                            WHERE
                                ${editAlias}.${marketKey}=${marketAlias}.action_index AND
                                ${listReferenceSql(editAlias)}
                        )
                    )
                ORDER BY ${marketAlias}.action_index ASC`;
}

async function targetReferences(db, list_root){
    let rows = await db.doQuery(
        `SELECT action_index
         FROM lists
         WHERE list_action_index=?`,
        [list_root]
    );
    let references = [list_root];
    for(let row of rows) references.push(row.action_index);
    return references;
}

function candidateArgs(list_root){
    return Array(8).fill(list_root);
}

function referencesTarget(value, targets){
    if(value === null || value === undefined || value === false || Number(value) === 0)
        return false;
    return targets.has(String(value));
}

async function getOpenMarketsByList(db, list_root, kind, editMethod){
    let references = await targetReferences(db, list_root);
    let targets = new Set(references.map(String));
    let rows = await db.doQuery(candidateSql(kind), candidateArgs(list_root));
    let matches = [];
    for(let row of rows){
        let allowList = row.allow_list;
        let blockList = row.block_list;
        let edit = await db[editMethod](row.action_index);
        if(edit.allow_list !== false) allowList = edit.allow_list;
        if(edit.block_list !== false) blockList = edit.block_list;
        if(referencesTarget(allowList, targets) || referencesTarget(blockList, targets))
            matches.push(Number(row.action_index));
    }
    return matches.sort((a, b) => a - b);
}

async function getOpenOrdersByList(db, list_root){
    return getOpenMarketsByList(db, list_root, 'order', 'getOrderEdits');
}

async function getOpenSwapsByList(db, list_root){
    return getOpenMarketsByList(db, list_root, 'swap', 'getSwapEdits');
}

module.exports = { getOpenOrdersByList, getOpenSwapsByList };

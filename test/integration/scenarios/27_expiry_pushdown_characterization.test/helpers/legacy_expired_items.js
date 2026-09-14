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
 * test/integration/scenarios/27_expiry_pushdown_characterization.test/helpers/legacy_expired_items.js
 *
 * The pre-push-down expiry sweep the characterization in
 * 27_expiry_pushdown_characterization.test.js compares the current one against, kept here
 * whole so the suite reads its behaviour rather than a paraphrase of it.
 */

'use strict';

/**
 * The open-item union the pre-push-down implementation built, one SELECT per table type,
 * with the SQL text exactly as it stood in src/db.js.
 */
function legacyOpenItemsQuery(types) {
    let query = '';
    // Build out the query for each of the table types to get 'open' items
    for(let type of types){
        if(query!='')
            query += 'UNION ';
        query += `SELECT
                    m.action_index,
                    m.expiration,
                    '` + type + `' as type
                FROM
                    ` + type + `s m
                    INNER JOIN ` + type + `_statuses s1 ON (s1.` + type + `_action_index=m.action_index)
                    INNER JOIN index_statuses        s2 ON (s2.id=s1.status_id)
                WHERE
                    s1.action_index = (
                        SELECT
                            MAX(s3.action_index)
                        FROM
                            ` + type + `_statuses s3
                        WHERE
                            s3.` + type + `_action_index=m.action_index
                    ) AND
                    s2.status='open'`;
    }
    return query + ' ORDER BY action_index ASC';
}

/**
 * The per-type edit lookup the pre-push-down implementation ran for the items it found,
 * again with the SQL text exactly as it stood in src/db.js.
 */
function legacyEditsQuery(type, placeholders) {
    return `SELECT
                s1.` + type + `_action_index as item_action_index,
                s1.expiration
            FROM
                ` + type + `_edits s1
                INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
            WHERE
                s1.` + type + `_action_index IN (` + placeholders + `) AND
                s2.status=?
            ORDER BY
                s1.action_index ASC`;
}

/**
 * The pre- implementation, copied verbatim from src/db.js so the
 * characterization compares against the real prior behaviour rather than a
 * paraphrase of it. Only `this` was rebound to an explicit db argument.
 * Its two query strings sit, unchanged, in the builders above.
 */
async function legacyGetExpiredItems(db, block_time) {
    let expired = [];
    let types   = ['order','swap','dispenser'];
    let args    = [];
    let results = await db.doQuery(legacyOpenItemsQuery(types), args);
    if(results.length > 0){
        let byType = {};
        for(let info of results){
            if(!byType[info.type])
                byType[info.type] = [];
            byType[info.type].push(info);
        }
        for(let type of Object.keys(byType)){
            let items        = byType[type];
            let placeholders = items.map(() => '?').join(',');
            args         = items.map(i => i.action_index).concat(['valid']);
            let results2 = await db.doQuery(legacyEditsQuery(type, placeholders), args);
            if(results2.length > 0){
                let latest = {};
                for(let row of results2){
                    if(!db.util.isNull(row.expiration))
                        latest[row.item_action_index] = row.expiration;
                }
                for(let info of items){
                    if(latest[info.action_index] !== undefined)
                        info.expiration = latest[info.action_index];
                }
            }
        }
        for(let info of results){
            if(info.expiration < block_time){
                expired.push({
                    type:         info.type,
                    action_index: Number(info.action_index),
                    expiration:   Number(info.expiration)
                });
            }
        }
    }
    return expired;
}

module.exports = { legacyGetExpiredItems };

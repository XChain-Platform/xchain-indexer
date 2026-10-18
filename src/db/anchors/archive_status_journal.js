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
 * XChain Indexer - Database helper: anchors / archive_status_journal
 *
 * Writes an archive status to anchor_actions. Required by db/anchors/index.js
 * and not a mixin part, so it adds no prototype method.
 *
 ********************************************************************/

const { archiveHeadPredicate } = require('../../consensus/state_hash');

async function writeArchiveStatus(db, actionIndex, statusId, archiveHeadOnly, journal){
    if(archiveHeadOnly){
        if(journal === true){
            return await db.doQuery(
                "UPDATE anchor_actions a SET a.pre_archive_status_id = IF(a.status_id = ?, a.pre_archive_status_id, a.status_id), a.status_id = ? WHERE a.action_index = ? AND " +
                archiveHeadPredicate('a'),
                [statusId, statusId, actionIndex]);
        }
        return await db.doQuery(
            "UPDATE anchor_actions a SET a.status_id = ? WHERE a.action_index = ? AND " +
            archiveHeadPredicate('a'),
            [statusId, actionIndex]);
    }
    if(journal === true){
        return await db.doQuery(
            "UPDATE anchor_actions SET pre_archive_status_id = IF(status_id = ?, pre_archive_status_id, status_id), status_id = ? WHERE action_index = ?",
            [statusId, statusId, actionIndex]);
    }
    return await db.doQuery(
        "UPDATE anchor_actions SET status_id = ? WHERE action_index = ?",
        [statusId, actionIndex]);
}

module.exports = { writeArchiveStatus };

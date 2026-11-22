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

const COMPLETION_QUERY = 'SELECT action_index, manifest_action_index, result, block_index FROM file_completions WHERE manifest_action_index=? ORDER BY action_index ASC LIMIT 1';

function makeMultipartIo(db){
    return {
        getGroup(source, fileHash){
            return db.getGroup(source, fileHash);
        },

        async getCompletion(manifestActionIndex){
            const rows = await db.doQuery(COMPLETION_QUERY, [manifestActionIndex]);
            return rows[0] || null;
        },

        createCompletion(row){
            return db.createCompletion({
                ACTION_INDEX: row.action_index,
                MANIFEST_ACTION_INDEX: row.manifest_action_index,
                RESULT: row.result,
                BLOCK_INDEX: row.block_index,
            });
        },
    };
}

module.exports = { makeMultipartIo };

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
 * XChain Indexer - Database mixin part: bets / terminal batch
 *
 * The set-based terminal flip for many bets moving to one status in one action: the
 * same end rows as setBetSettled plus createBetStatus per bet, written a chunk of bets
 * per statement instead of five round trips per bet. Merged into the bets mixin by
 * db/bets/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Bets per statement; keeps each IN list and multi-row INSERT well under the packet limit.
const BET_TERMINAL_BATCH = 500;

module.exports = {

    // Move every listed bet to `status` at `block_index`, and record the history row
    // caused by `action_index` for each, upserting exactly as createBetStatus does.
    async settleBetsBatch(action_index, bet_action_indexes, status, block_index){
        // Drop repeats, keeping first-seen order (a repeat would upsert, not insert twice)
        let ids = [...new Set(bet_action_indexes.map(Number))];
        if(ids.length === 0)
            return;
        // Resolve the status id once for the whole batch
        let status_id = await this.createStatus(status);
        for(let i = 0; i < ids.length; i += BET_TERMINAL_BATCH){
            let chunk = ids.slice(i, i + BET_TERMINAL_BATCH);
            let marks = chunk.map(() => '?').join(',');
            // Current-status column and settled_block stamp, one UPDATE per chunk
            await this.doQuery(`UPDATE bets SET bet_status_id=?, settled_block=? WHERE action_index IN (${marks})`,
                [status_id, block_index, ...chunk]);
            // History rows this action already wrote are updated in place, the rest inserted
            let rows = await this.doQuery(`SELECT bet_action_index FROM bet_statuses WHERE action_index=? AND bet_action_index IN (${marks})`,
                [action_index, ...chunk]);
            let existing = new Set(rows.map(row => Number(row.bet_action_index)));
            let present  = chunk.filter(id => existing.has(id));
            let missing  = chunk.filter(id => !existing.has(id));
            if(present.length > 0)
                await this.doQuery(`UPDATE bet_statuses SET status_id=? WHERE action_index=? AND bet_action_index IN (${present.map(() => '?').join(',')})`,
                    [status_id, action_index, ...present]);
            if(missing.length > 0)
                await this.doQuery(`INSERT INTO bet_statuses (status_id, action_index, bet_action_index) values ${missing.map(() => '(?, ?, ?)').join(', ')}`,
                    missing.flatMap(id => [status_id, action_index, id]));
        }
    },

};

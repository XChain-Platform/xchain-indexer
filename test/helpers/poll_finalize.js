/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/helpers/poll_finalize.js
 *
 * The real finalizePoll run over a stubbed tally, for the suites that check which
 * poll_results rows a poll's finalize writes.
 */

'use strict';

const Utility = require('../../src/utility');
const pollsDb = require('../../src/db/polls/index.js');

// poll_results INSERT order: action_index, block_index, poll_index, option_index,
// total_weight, voter_count, resolved_block, status_id.
const OPTION_INDEX_AT = 3;

// The poll_results INSERT arguments finalizePoll binds for a poll storing these option
// labels, over a tally with no counted ballot (every option at weight 0, no winner).
async function finalizeInserts(labels){
    const inserts = [];
    const db = Object.assign({
        util: new Utility(),
        createStatus: async () => 9,
        getPollTally: async () => ({
            options: labels.map((label, i) => ({ index: i, label, weight: '0', voters: 0 })),
            quorum_met: true, min_voters_met: true, winning_option: null, total_counted_weight: '0', total_voters: 0
        }),
        doQuery: async (sql, args) => { if(/INSERT INTO poll_results/.test(sql)) inserts.push(args); return []; },
    }, pollsDb);
    await db.finalizePoll({ POLL_REF: 50, ACTION_INDEX: 70, BLOCK_INDEX: 300, EFFECTIVE_CLOSE_BLOCK: 300, STATUS: 'valid' });
    return inserts;
}

module.exports = { finalizeInserts, OPTION_INDEX_AT };

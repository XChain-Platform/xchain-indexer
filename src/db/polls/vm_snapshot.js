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
 * XChain Indexer - Database mixin part: polls (VM snapshot)
 *
 * The consensus-visible snapshot of finalized poll results the VM reads.
 * A part of the polls mixin: src/db/polls/index.js merges it into the one method set that
 * db/index.js installs onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// The finalized set's option rows grouped by poll, in the order the read returned them.
function groupOptionsByPoll(optionRows){
    // String keys on both sides: the pool runs bigIntAsNumber, so both BIGINT
    // columns arrive as Numbers, and String() of each is the same decimal.
    let optionsByPoll = new Map();
    for(let o of optionRows){
        let key  = String(o.poll_index);
        let list = optionsByPoll.get(key);
        if(!list){
            list = [];
            optionsByPoll.set(key, list);
        }
        list.push({
            index: Number(o.option_index),
            weight: String(o.total_weight),
            voters: Number(o.voter_count)
        });
    }
    return optionsByPoll;
}

module.exports = {

    // Serializable snapshot of finalized poll results for the VM (backs
    // xchain.getPollResult). The VM worker rebuilds the getPollResult accessor
    // from this plain map (keys are poll indices).
    //
    // CONSENSUS RULE (mirrors getCrossChainDataForVM): only polls finalized in
    // blocks STRICTLY BEFORE the current one are exposed (resolved_block <
    // block_index). A poll is finalized by the per-block sweep AFTER that block's
    // actions run, so this bound also guarantees a poll never reads as decided
    // within its own finalization block, identically on every node and on replay.
    //
    // `includeTick` is the VOTE_POLL_TICK_VISIBLE flag-day gate (resolved by the
    // caller from the host block): below it the entry shape is byte-identical to
    // the pre-flag snapshot (no `tick` key); at/above it each entry gains a
    // `tick` field (the poll's immutable electorate, resolved through
    // index_tickers). Gating the KEY's presence, not just its value, keeps a
    // from-genesis replay of a pre-flag block identical on every node.
    async getPollResultsForVM(block_index, includeTick=false){
        let polls = {};
        let bound = Number(block_index) || 0;
        let rows = await this.doQuery(
            `SELECT p.action_index, p.poll_status, p.winning_option, p.total_weight,
                    p.total_voters, p.decided_early, t.tick
               FROM polls p
               LEFT JOIN index_tickers t ON (t.id = p.tick_id)
              WHERE p.poll_status IN ('finalized','failed_quorum')
                AND p.resolved_block IS NOT NULL AND p.resolved_block < ?`,
            [bound]);
        if(rows.length === 0)
            return { polls: polls };
        // Options for the WHOLE finalized set in ONE ordered read, grouped in JS.
        // This replaces a per-poll query inside the loop below, which cost one round
        // trip per historical poll on EVERY execution and deployment (finding #7080).
        // The predicate is character-for-character the poll query's, so the grouped
        // rows are exactly the union of what the per-poll reads returned; polls
        // (action_index) is UNIQUE, so the join cannot duplicate an option row.
        // The snapshot is consensus-visible, so the entries below are still built
        // from the POLLS rows in their existing order: a finalized poll with no
        // poll_results rows must keep yielding `options: []`, and key insertion
        // order must not shift.
        let optionRows = await this.doQuery(
            `SELECT pr.poll_index, pr.option_index, pr.total_weight, pr.voter_count
               FROM poll_results pr
               JOIN polls p ON (p.action_index = pr.poll_index)
              WHERE p.poll_status IN ('finalized','failed_quorum')
                AND p.resolved_block IS NOT NULL AND p.resolved_block < ?
              ORDER BY pr.poll_index ASC, pr.option_index ASC`,
            [bound]);
        let optionsByPoll = groupOptionsByPoll(optionRows);
        for(let r of rows){
            let options = optionsByPoll.get(String(r.action_index)) || [];
            let entry = {
                status:         r.poll_status,
                winning_option: this.util.isNull(r.winning_option) ? null : Number(r.winning_option),
                total_weight:   this.util.isNull(r.total_weight) ? null : String(r.total_weight),
                total_voters:   this.util.isNull(r.total_voters) ? null : Number(r.total_voters),
                decided_early:  this.util.isNull(r.decided_early) ? null : !!Number(r.decided_early),
                options:        options
            };
            if(includeTick) entry.tick = this.util.isNull(r.tick) ? null : String(r.tick);
            polls[String(r.action_index)] = entry;
        }
        return { polls: polls };
    },

};

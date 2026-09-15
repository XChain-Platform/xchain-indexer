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
 * XChain Indexer - Database mixin: polls
 * 
 * The queries over the polls table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>(). The poll create write and the VM
 * snapshot live in parts under polls/, and this file is the entry that merges them into the
 * one method set it exports.
 *
 ********************************************************************/

const path    = require('path');
const pollCreate = require('./poll_create.js');
const vmSnapshot = require('./vm_snapshot.js');

module.exports = Object.assign({

    // Fetch a poll definition row by its id (the VOTE v0 action_index). Returns
    // null if no such poll exists.
    async getPoll(pollIndex){
        let results = await this.doQuery(`SELECT * FROM polls WHERE action_index=? LIMIT 1`, [pollIndex]);
        if(!results || results.length === 0) return null;
        return results[0];
    },

    // Mark a poll's creation deposit as released ('refunded' or 'forfeited'). Called
    // by VOTE v2 after the escrow ledger change so a reprocessed finalize is a no-op
    // (the escrow itself is idempotent via action_index, this records the outcome).
    async setPollDepositResolved(pollIndex, resolved){
        await this.doQuery(`UPDATE polls SET deposit_resolved=? WHERE action_index=?`, [resolved, pollIndex]);
    },

    // Record the action_index of the EXECUTE that VOTE v2 injected for a binding
    // poll's callback. Cleared on rollback re-open so a re-synthesized v2 re-fires.
    async setPollCallbackIndex(pollIndex, executeActionIndex){
        await this.doQuery(`UPDATE polls SET callback_execute_action_index=? WHERE action_index=?`, [executeActionIndex, pollIndex]);
    },

    // timelock: stamp the block a deferred binding callback fires at
    // (resolved_block + CALLBACK_DELAY_BLOCKS). Written by VOTE v2 in place of the
    // immediate injection; cleared by the rollback re-open reset.
    async setPollCallbackDue(pollIndex, dueBlock){
        await this.doQuery(`UPDATE polls SET callback_due_block=? WHERE action_index=?`, [dueBlock, pollIndex]);
    },

    // timelock: terminal polls whose deferred callback comes due exactly at
    // block_index and has not fired. Equality (not <=) mirrors the immediate path's
    // fire-once-at-v2 semantics; the IS NULL guard makes a same-block reprocess
    // idempotent. Returns the full row (the sweep reconstructs the frozen result
    // from it).
    async getDueCallbackPolls(block_index){
        return await this.doQuery(
            `SELECT * FROM polls
              WHERE poll_status IN ('finalized','failed_quorum')
                AND callback_due_block = ?
                AND callback_execute_action_index IS NULL
              ORDER BY action_index ASC`, [block_index]);
    },

    // Select open polls whose voting window has closed by block_index (time
    // trigger for finalization). Mirrors getExpiredAttestationRequests: the
    // per-block sweep injects a synthetic VOTE v2 for each. end_block is the
    // effective close for these (balances measured there even if the v2 lands
    // a block late).
    async getDuePolls(block_index){
        return await this.doQuery(
            `SELECT action_index, end_block FROM polls
              WHERE poll_status='open' AND end_block <= ?
              ORDER BY action_index ASC`, [block_index]);
    },

    // Select open polls that are armed for early-decide (a decide_threshold is
    // set) and not yet time-due (end_block still in the future; a poll at its
    // end_block finalizes via the time path). The sweep evaluates each one's
    // provisional tally at the current block to decide whether to close early.
    async getArmedPolls(block_index){
        // tick_id / weight_mode / decide_threshold are returned alongside action_index so the
        // sweep can compute the tally watermark and evaluate the threshold without a second
        // getPoll() round-trip per armed poll per block. These are immutable poll
        // definition columns, so carrying them here is equivalent to the prior separate fetch.
        return await this.doQuery(
            `SELECT action_index, tick_id, weight_mode, decide_threshold FROM polls
              WHERE poll_status='open'
                AND decide_threshold IS NOT NULL AND decide_threshold <> ''
                AND end_block > ?
              ORDER BY action_index ASC`, [block_index]);
    },

    // Freeze a poll's result on-chain (system-injected VOTE v2). Computes the
    // deterministic tally at the effective close block (reusing getPollTally, the
    // single source of truth for the math), writes one poll_results row per option,
    // and flips the polls row terminal. Returns the computed tally for logging.
    //
    // `data` carries the v2 action's ACTION_INDEX + BLOCK_INDEX and the sweep's
    // EFFECTIVE_CLOSE_BLOCK / DECIDED_EARLY. A poll that fails either validity gate
    // terminates 'failed_quorum' with no winner (results still recorded).
    async finalizePoll(data){
        let pollIndex     = Number(data['POLL_REF']);
        let actionIndex   = data['ACTION_INDEX'];
        let block_index   = data['BLOCK_INDEX'];
        let closeBlock    = Number(data['EFFECTIVE_CLOSE_BLOCK']);
        let decidedEarly  = data['DECIDED_EARLY'] ? 1 : 0;
        let status_id     = await this.createStatus(data['STATUS']);

        let tally = await this.getPollTally(pollIndex, closeBlock);
        if(this.util.isNull(tally)) return null;

        let passed   = tally.quorum_met && tally.min_voters_met;
        let terminal = passed ? 'finalized' : 'failed_quorum';
        let fail_reason = null;
        if(!passed){
            if(!tally.quorum_met && !tally.min_voters_met) fail_reason = 'both';
            else if(!tally.quorum_met)                     fail_reason = 'quorum';
            else                                           fail_reason = 'min_voters';
        }
        // No winner is recorded for a poll that failed its gates.
        let winning_option = passed ? tally.winning_option : null;

        // One poll_results row per option (per-option weight + distinct voter count)
        for(let opt of tally.options){
            await this.doQuery(
                `INSERT INTO poll_results
                    (action_index, block_index, poll_index, option_index, total_weight, voter_count, resolved_block, status_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [actionIndex, block_index, pollIndex, opt.index, String(opt.weight), opt.voters, block_index, status_id]);
        }

        // Flip the polls summary terminal. resolved_block anchors the reorg reset.
        await this.doQuery(
            `UPDATE polls SET
                poll_status=?, winning_option=?, total_weight=?, total_voters=?,
                quorum_met=?, min_voters_met=?, fail_reason=?, decided_early=?,
                effective_close_block=?, finalized_action_index=?, resolved_block=?
             WHERE action_index=?`,
            [terminal, winning_option, String(tally.total_counted_weight), tally.total_voters,
             tally.quorum_met ? 1 : 0, tally.min_voters_met ? 1 : 0, fail_reason, decidedEarly,
             closeBlock, actionIndex, block_index, pollIndex]);

        return Object.assign({}, tally, { poll_status: terminal, fail_reason, decided_early: decidedEarly, winning_option });
    },

    // Read a poll's frozen result (the VM host function xchain.getPollResult and
    // the explorer read this). Returns the polls summary plus per-option rows. For
    // an open (not-yet-finalized) poll, poll_status is 'open' and the finalization
    // fields are null, so a contract can tell "not decided yet" from a real result.
    async getPollResult(pollIndex){
        let poll = await this.getPoll(pollIndex);
        if(this.util.isNull(poll)) return null;
        let options = JSON.parse(poll.options || '[]');
        // Resolve the poll's electorate ticker: the read/explorer path
        // always carries it; the consensus VM snapshot gates it (getPollResultsForVM).
        let tick = this.util.isNull(poll.tick_id) ? null : await this.getTicker(poll.tick_id);
        let rows = await this.doQuery(
            `SELECT option_index, total_weight, voter_count FROM poll_results
              WHERE poll_index=? ORDER BY option_index ASC`, [pollIndex]);
        let optionResults = [];
        for(let i=0;i<options.length;i++){
            let r = rows.find(x => Number(x.option_index) === i);
            optionResults.push({
                index: i, label: options[i],
                weight: r ? String(r.total_weight) : '0',
                voters: r ? Number(r.voter_count) : 0
            });
        }
        return {
            poll_index: Number(pollIndex),
            tick: this.util.isNull(tick) ? null : String(tick),
            poll_status: poll.poll_status,
            winning_option: this.util.isNull(poll.winning_option) ? null : Number(poll.winning_option),
            total_weight: this.util.isNull(poll.total_weight) ? null : String(poll.total_weight),
            total_voters: this.util.isNull(poll.total_voters) ? null : Number(poll.total_voters),
            quorum_met: this.util.isNull(poll.quorum_met) ? null : !!Number(poll.quorum_met),
            min_voters_met: this.util.isNull(poll.min_voters_met) ? null : !!Number(poll.min_voters_met),
            fail_reason: poll.fail_reason || null,
            decided_early: this.util.isNull(poll.decided_early) ? null : !!Number(poll.decided_early),
            effective_close_block: this.util.isNull(poll.effective_close_block) ? null : Number(poll.effective_close_block),
            options: optionResults
        };
    },

}, pollCreate, vmSnapshot);

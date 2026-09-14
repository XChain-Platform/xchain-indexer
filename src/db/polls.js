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
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');

module.exports = {

    // Create/Update a poll record (VOTE v0). Keyed by the create action_index,
    // which is the poll's id. OPTIONS are stored as a JSON array, index-addressed
    // by ballots. Defaults (max_selections=1, tally_mode=approval,
    // weight_mode=balance) are applied by the handler before this is called.
    async createPoll(data){
        let action_index     = data['ACTION_INDEX'];
        let block_index      = data['BLOCK_INDEX'];
        let tick_id          = await this.createTicker(data['TICK']);
        let status_id        = await this.createStatus(data['STATUS']);
        let end_block        = data['END_BLOCK'];
        let optionsArr       = String(data['OPTIONS']).split(',').map(o => o.trim());
        let options          = JSON.stringify(optionsArr);
        let max_selections   = data['MAX_SELECTIONS'];
        let tally_mode       = data['TALLY_MODE'];
        let weight_mode      = data['WEIGHT_MODE'];
        let quorum           = data['QUORUM'];
        let min_voters       = data['MIN_VOTERS'];
        let min_vote_balance = data['MIN_VOTE_BALANCE'];
        let decide_threshold = data['DECIDE_THRESHOLD'];
        let question         = data['QUESTION'];
        // Creation deposit (anti-spam): parseCreate normalizes DEPOSIT to a numeric
        // string ('0' when none). Store the amount and the creator address id (the
        // refund target) so VOTE v2 can release the escrow without re-deriving SOURCE.
        let deposit_amount   = this.util.isNull(data['DEPOSIT']) ? '0' : String(data['DEPOSIT']);
        // Binding-poll callback fields (null on a signaling poll). callback_params is
        // stored as the raw JSON array string; gas_escrow defaults to '0'.
        let binding          = !this.util.isNull(data['CALLBACK_CONTRACT']) && String(data['CALLBACK_CONTRACT']).trim() !== '';
        let cb_contract      = binding ? parseInt(data['CALLBACK_CONTRACT']) : null;
        let cb_method        = binding ? data['CALLBACK_METHOD'] : null;
        let cb_params        = binding ? (this.util.isNull(data['CALLBACK_PARAMS']) ? null : String(data['CALLBACK_PARAMS'])) : null;
        let cb_on            = binding ? (data['CALLBACK_ON'] || 'pass') : null;
        let gas_escrow       = binding ? (this.util.isNull(data['GAS_ESCROW']) ? '0' : String(data['GAS_ESCROW'])) : null;
        // CALLBACK_DELAY_BLOCKS timelock: parseCreate nulls the field below
        // the VOTE_CALLBACK_TIMELOCK flag-day, so a stored value is always gate-legal.
        let cb_delay         = (binding && !this.util.isNull(data['CALLBACK_DELAY_BLOCKS'])) ? parseInt(data['CALLBACK_DELAY_BLOCKS']) : null;
        // deposit_address_id is the escrow PAYER (= creator), stored whenever any GAS
        // is locked (deposit OR gas_escrow) so v2 can resolve the refund target.
        let has_escrow       = this.util.bcgt(deposit_amount, 0) || (binding && this.util.bcgt(gas_escrow, 0));
        let deposit_addr_id  = has_escrow ? await this.createAddress(data['SOURCE']) : null;
        // INSERT/UPDATE keyed by action_index (poll definition is immutable, but
        // reprocessing the same action must be idempotent)
        let query   = `SELECT action_index FROM polls WHERE action_index=?`;
        let results = await this.doQuery(query, [action_index]);
        let exists  = (results.length > 0);
        if(exists){
            query = `UPDATE polls SET
                        block_index=?, tick_id=?, end_block=?, options=?, max_selections=?,
                        tally_mode=?, weight_mode=?, quorum=?, min_voters=?, min_vote_balance=?,
                        decide_threshold=?, question=?, deposit_amount=?, deposit_address_id=?,
                        callback_contract_index=?, callback_method=?, callback_params=?,
                        callback_on=?, gas_escrow=?, callback_delay_blocks=?, status_id=?
                     WHERE action_index=?`;
        } else {
            query = `INSERT INTO polls
                        (block_index, tick_id, end_block, options, max_selections,
                         tally_mode, weight_mode, quorum, min_voters, min_vote_balance,
                         decide_threshold, question, deposit_amount, deposit_address_id,
                         callback_contract_index, callback_method, callback_params,
                         callback_on, gas_escrow, callback_delay_blocks, status_id, action_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        let args = [block_index, tick_id, end_block, options, max_selections,
                    tally_mode, weight_mode, quorum, min_voters, min_vote_balance,
                    decide_threshold, question, deposit_amount, deposit_addr_id,
                    cb_contract, cb_method, cb_params, cb_on, gas_escrow, cb_delay, status_id, action_index];
        await this.doQuery(query, args);
    },

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

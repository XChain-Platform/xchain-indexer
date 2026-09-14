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
 * XChain Platform Action - VOTE : validation
 *
 * The checks a VOTE create (v0) and a ballot (v1) pass before anything is
 * written: the SOURCE gates, the poll's own rules and thresholds, the anti-spam
 * DEPOSIT, the referenced poll and the BALLOT field. Each takes the error so far
 * and returns it, with any value the next phase needs. Called with the VOTE
 * handler as `this` (see ../vote.js).
 *
 ********************************************************************/

'use strict';

// VOTE v0 phase - the SOURCE gates: a sleeping creator, a TICK that must be a real
// issued token, and the anti-spam requirement that the creator holds it.
async function validateCreateSource(data, error){
    let block_index  = parseInt(data['BLOCK_INDEX']);
    let action_index = data['ACTION_INDEX'];

    // Reject a sleeping SOURCE (v0 moves GAS into escrow while the address is
    // supposedly frozen). Flag-day gated: see VOTE_RESPECTS_SLEEP in
    // protocol_changes.js for why this validity tightening is gated.
    if(!error && await this.actions.protocolChanges.isEnabled('VOTE_RESPECTS_SLEEP', data['BLOCK_INDEX'])
              && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        error = 'invalid: SOURCE (sleeping)';

    // TICK must be a real, issued token (the electorate + weight basis)
    let tokenInfo = null;
    if(!error){
        if(this.util.isNull(data['TICK']))
            error = 'invalid: TICK (missing)';
        else {
            tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], block_index, action_index);
            if(this.util.isNull(tokenInfo))
                error = 'invalid: TICK (unknown)';
        }
    }

    // Anti-spam: the creator must hold a non-zero balance of TICK at creation.
    // Stops an address with no stake from spamming polls / faking governance.
    if(!error){
        let tick_id  = await this.indexerDb.createTicker(data['TICK']);
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, block_index, action_index);
        let bal      = balances[tick_id];
        if(this.util.isNull(bal) || !this.util.bcgt(bal, 0))
            error = 'invalid: SOURCE (must hold TICK to create poll)';
    }

    return error;
}

// VOTE v0 phase - the poll's own shape: when it closes, what can be chosen, how the
// choices are tallied and how weight is derived.
function validateCreatePollRules(data, error){
    let block_index = parseInt(data['BLOCK_INDEX']);

    // END_BLOCK must be a future block
    if(!error){
        if(!this.util.isNumeric(data['END_BLOCK']) || parseInt(data['END_BLOCK']) <= block_index)
            error = 'invalid: END_BLOCK (must be a future block)';
    }

    // OPTIONS: comma-delimited list, at least two non-empty entries
    let optionCount = 0;
    if(!error){
        let opts = String(data['OPTIONS']).split(',').map(o => o.trim()).filter(o => o.length > 0);
        optionCount = opts.length;
        if(optionCount < 2)
            error = 'invalid: OPTIONS (need at least 2)';
    }

    // MAX_SELECTIONS: positive integer, no more than the option count
    if(!error){
        let ms = Number(data['MAX_SELECTIONS']);
        if(!Number.isInteger(ms) || ms < 1 || ms > optionCount)
            error = 'invalid: MAX_SELECTIONS (range)';
    }

    // TALLY_MODE: approval (full weight per option) or split (divided by shares)
    if(!error && !['approval','split'].includes(data['TALLY_MODE']))
        error = 'invalid: TALLY_MODE (value)';

    // WEIGHT_MODE: balance (close holdings), flat (one-address-one-vote),
    // quadratic (sqrt of close balance, anti-whale), time_weighted (windowed
    // average holdings). 'stake' remains reserved for a later phase.
    if(!error && !['balance','flat','quadratic','time_weighted'].includes(data['WEIGHT_MODE']))
        error = 'invalid: WEIGHT_MODE (value)';

    // quadratic REQUIRES a dust floor: sqrt(a)+sqrt(b) > sqrt(a+b), so without
    // a per-voter floor a holder could split across addresses to inflate total
    // quadratic weight. MIN_VOTE_BALANCE raises the cost of that sybil split.
    // Sybil-resistant, not sybil-proof (documented).
    if(!error && data['WEIGHT_MODE'] === 'quadratic'){
        if(this.util.isNull(data['MIN_VOTE_BALANCE']) || !this.util.bcgt(data['MIN_VOTE_BALANCE'], 0))
            error = 'invalid: quadratic WEIGHT_MODE requires MIN_VOTE_BALANCE > 0';
    }

    return error;
}

// VOTE v0 phase - the optional outcome thresholds and the free-text question.
function validateCreateThresholds(data, error){
    // QUORUM (optional): fraction of supply, 0 < q <= 1
    if(!error && !this.util.isNull(data['QUORUM'])){
        let q = Number(data['QUORUM']);
        if(!this.util.isNumeric(data['QUORUM']) || q <= 0 || q > 1)
            error = 'invalid: QUORUM (fraction 0-1)';
    }

    // MIN_VOTERS (optional): non-negative integer
    if(!error && !this.util.isNull(data['MIN_VOTERS'])){
        let mv = Number(data['MIN_VOTERS']);
        if(!Number.isInteger(mv) || mv < 0)
            error = 'invalid: MIN_VOTERS (non-negative integer)';
    }

    // MIN_VOTE_BALANCE (optional): non-negative amount
    if(!error && !this.util.isNull(data['MIN_VOTE_BALANCE'])){
        if(!this.util.isNumeric(data['MIN_VOTE_BALANCE']) || this.util.bclt(data['MIN_VOTE_BALANCE'], 0))
            error = 'invalid: MIN_VOTE_BALANCE (non-negative amount)';
    }

    // DECIDE_THRESHOLD (optional, acted on in Phase 2): fraction of supply, 0 < d <= 1
    if(!error && !this.util.isNull(data['DECIDE_THRESHOLD'])){
        let d = Number(data['DECIDE_THRESHOLD']);
        if(!this.util.isNumeric(data['DECIDE_THRESHOLD']) || d <= 0 || d > 1)
            error = 'invalid: DECIDE_THRESHOLD (fraction 0-1)';
    }

    // QUESTION (optional) shares the MAX_MESSAGE_LENGTH ceiling with every other free-text
    // field, because all of them ride the one compiled action string.
    if(!error && !this.util.isNull(data['QUESTION']) && String(data['QUESTION']).length > this.config['MAX_MESSAGE_LENGTH'])
        error = 'invalid: QUESTION (length)';

    return error;
}

// VOTE v0 phase - the anti-spam DEPOSIT: its floor, its funding, and the normalized
// value carried on the data object for createPoll. Returns the error and the deposit.
async function validateCreateDeposit(data, error){
    let block_index  = parseInt(data['BLOCK_INDEX']);
    let action_index = data['ACTION_INDEX'];

    // DEPOSIT (optional anti-spam escrow): GAS the creator locks at
    // creation, refunded on 'finalized' or forfeited to the DONATE1 treasury on
    // 'failed_quorum' (released by VOTE v2). Normalize to a numeric string ('0'
    // = none) and enforce the POLL_DEPOSIT_MIN floor. The actual escrow happens
    // after the poll row is written, only when valid.
    let gas        = this.config['GAS'];
    let depositMin = this.config['POLL_DEPOSIT_MIN'] || '0';
    let deposit    = this.util.isNull(data['DEPOSIT']) ? '0' : String(data['DEPOSIT']).trim();
    if(!error){
        if(!this.util.isNumeric(deposit) || this.util.bclt(deposit, 0))
            error = 'invalid: DEPOSIT (non-negative amount)';
        else if(this.util.bclt(deposit, depositMin))
            error = 'invalid: DEPOSIT (below POLL_DEPOSIT_MIN ' + depositMin + ')';
    }
    // Funding check: SOURCE must hold the DEPOSIT in GAS, read at
    // (block, action) so accept/reject is identical across validators.
    if(!error && this.util.bcgt(deposit, 0)){
        let gasInfo  = await this.indexerDb.getTokenInfo(gas, block_index, action_index);
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, block_index, action_index);
        if(!gasInfo || !this.util.hasBalance(balances, gasInfo['TICK_ID'], deposit))
            error = 'invalid: insufficient funds (DEPOSIT)';
    }
    // Carry the normalized deposit so createPoll stores a clean '0' when absent.
    data['DEPOSIT'] = deposit;

    return { error: error, deposit: deposit };
}

// VOTE v1 phase - the gates a ballot passes before its content is read: a sleeping
// voter, the poll it references, the voting window, and holding TICK at cast time.
// Returns the error and the referenced poll.
async function validateBallotPoll(data, error){
    let block_index  = parseInt(data['BLOCK_INDEX']);
    let action_index = data['ACTION_INDEX'];

    // Reject a sleeping SOURCE (a frozen address must not cast or mutate
    // ballots). Flag-day gated: see VOTE_RESPECTS_SLEEP in protocol_changes.js.
    if(!error && await this.actions.protocolChanges.isEnabled('VOTE_RESPECTS_SLEEP', data['BLOCK_INDEX'])
              && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        error = 'invalid: SOURCE (sleeping)';

    // POLL_REF must reference an existing poll
    let poll = null;
    if(!error){
        // POLL_REF is a poll's own action_index, so a ballot for a poll that does not exist
        // is rejected rather than parked: there is nothing to attach the vote to.
        if(!this.util.isNumeric(data['POLL_REF']))
            error = 'invalid: POLL_REF (format)';
        else {
            poll = await this.indexerDb.getPoll(parseInt(data['POLL_REF']));
            if(this.util.isNull(poll))
                error = 'invalid: POLL_REF (unknown poll)';
        }
    }

    // Voting window: ballots accepted while cast_block <= end_block
    if(!error && block_index > Number(poll.end_block))
        error = 'invalid: poll closed';

    // Hold-to-vote gate (cast time, protocol level): voter must hold TICK now
    if(!error){
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, block_index, action_index);
        let bal      = balances[poll.tick_id];
        if(this.util.isNull(bal) || !this.util.bcgt(bal, 0))
            error = 'invalid: SOURCE (must hold TICK to vote)';
    }

    return { error: error, poll: poll };
}

// VOTE v1 phase - the BALLOT field itself: one or more OPTION or OPTION:SHARE entries,
// validated against the poll's options and tally mode. Returns the error and the
// selections to store.
function parseBallotSelections(poll, data, error){
    let selections = [];

    // Parse and validate the BALLOT (one or more OPTION or OPTION:SHARE entries)
    if(!error){
        let options     = JSON.parse(poll.options || '[]');
        let optionCount = options.length;
        let tally_mode  = poll.tally_mode || 'approval';
        let entries     = String(data['BALLOT']).split(',').map(e => e.trim()).filter(e => e.length > 0);
        let seen        = {};

        if(entries.length === 0)
            error = 'invalid: BALLOT (empty)';
        // Verify the ballot does not select more options than MAX_SELECTIONS allows
        if(!error && entries.length > Number(poll.max_selections))
            error = 'invalid: BALLOT (exceeds MAX_SELECTIONS)';

        for(let i = 0; !error && i < entries.length; i++){
            let parts  = entries[i].split(':');
            let choice = Number(parts[0]);
            let share  = (parts.length > 1) ? String(parts[1]).trim() : '1';
            // Option indexes are positions in the poll's stored OPTIONS array, so anything
            // outside it would tally a vote for an option the poll never offered.
            if(!Number.isInteger(choice) || choice < 0 || choice >= optionCount){
                error = 'invalid: BALLOT (option index out of range)';
                break;
            }
            // One entry per option: a repeated option would count the voter's weight twice
            // in approval mode and let a split ballot exceed its own share total.
            if(seen[choice]){
                error = 'invalid: BALLOT (duplicate option)';
                break;
            }
            seen[choice] = true;
            // In split mode a positive share is required; in approval mode the
            // share is ignored (stored as '1')
            if(tally_mode === 'split'){
                if(!this.util.isNumeric(share) || !this.util.bcgt(share, 0)){
                    error = 'invalid: BALLOT (share must be > 0 in split mode)';
                    break;
                }
            } else {
                share = '1';
            }
            selections.push({ choice: choice, share: share });
        }
    }

    return { error: error, selections: selections };
}

module.exports = {
    validateCreateSource, validateCreatePollRules, validateCreateThresholds, validateCreateDeposit,
    validateBallotPoll, parseBallotSelections
};

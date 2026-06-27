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
 * XChain Platform Action - VOTE
 *
 * Token-weighted governance polls. A single action sub-typed by version:
 *   v0 = create poll   (this file)
 *   v1 = cast ballot   (this file)
 *   v2 = finalize       (system-injected, Phase 2)
 *   v3 = delegation     (Phase 3)
 *
 * A poll is governed and decided by holders of one token (TICK), which is both
 * the electorate and the weight basis. Two protocol-level token gates back every
 * ballot: a voter must hold TICK at cast time (else the ballot is invalid), and a
 * ballot only counts at the effective close if the voter still holds TICK then
 * (enforced in the tally, db.getPollTally / VOTE v2). Weight is never read from
 * the payload.
 *
 * Spec: xchain-documentation/protocol/actions/VOTE.md
 *
 ********************************************************************/

class Vote {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS. v0 create + v1 ballot are user actions;
        // v2 finalize is system-injected only (the per-block sweep synthesizes it).
        this.formats = {};
        this.formats[0] = 'VERSION|TICK|END_BLOCK|OPTIONS|MAX_SELECTIONS|TALLY_MODE|WEIGHT_MODE|QUORUM|MIN_VOTERS|MIN_VOTE_BALANCE|DECIDE_THRESHOLD|QUESTION';
        this.formats[1] = 'VERSION|POLL_REF|BALLOT|MEMO';
        this.formats[2] = 'VERSION|POLL_REF';
        this.formats[3] = 'VERSION|TICK|DELEGATE_TO|MEMO';
    }

    // Handle parsing the VOTE transaction
    async parse(params, data, error){
        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Dispatch to the version-specific handler
        if(format===0)
            await this._parseCreate(data, error);
        else if(format===1)
            await this._parseBallot(data, error);
        else if(format===2)
            await this._parseFinalize(data, error);
        else if(format===3)
            await this._parseDelegate(data, error);
    }

    /*****************************************************************
     * VOTE v0 - create poll
     ****************************************************************/
    async _parseCreate(data, error){
        // Apply poll defaults before validation/storage
        if(this.util.isNull(data['MAX_SELECTIONS'])) data['MAX_SELECTIONS'] = '1';
        if(this.util.isNull(data['TALLY_MODE']))     data['TALLY_MODE']     = 'approval';
        if(this.util.isNull(data['WEIGHT_MODE']))    data['WEIGHT_MODE']    = 'balance';

        let block_index  = parseInt(data['BLOCK_INDEX']);
        let action_index = data['ACTION_INDEX'];

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
        // quadratic weight. MIN_VOTE_BALANCE raises that sybil cost (Section 12.1).
        // Sybil-resistant, not sybil-proof (documented).
        if(!error && data['WEIGHT_MODE'] === 'quadratic'){
            if(this.util.isNull(data['MIN_VOTE_BALANCE']) || !this.util.bcgt(data['MIN_VOTE_BALANCE'], 0))
                error = 'invalid: quadratic WEIGHT_MODE requires MIN_VOTE_BALANCE > 0';
        }

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

        // QUESTION (optional): bounded length
        if(!error && !this.util.isNull(data['QUESTION']) && String(data['QUESTION']).length > this.config['MAX_MESSAGE_LENGTH'])
            error = 'invalid: QUESTION (length)';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t VOTE create : " + data['TICK'] + ' : ' + data['STATUS']);

        // Persist the poll only when valid; an invalid create writes no poll row
        // (the action itself is still recorded in `actions` with its status)
        if(!error)
            await this.indexerDb.createPoll(data);

        // Store the SOURCE/TICK in addresses+tickers list, create action mappings
        this.util.addAddressTicker(data['SOURCE'], data['TICK']);
        await this.mapper.createMappings(data);
    }

    /*****************************************************************
     * VOTE v1 - cast ballot
     ****************************************************************/
    async _parseBallot(data, error){
        let block_index  = parseInt(data['BLOCK_INDEX']);
        let action_index = data['ACTION_INDEX'];
        let selections   = [];

        // POLL_REF must reference an existing poll
        let poll = null;
        if(!error){
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

        // Parse and validate the BALLOT (one or more OPTION or OPTION:SHARE entries)
        if(!error){
            let options     = JSON.parse(poll.options || '[]');
            let optionCount = options.length;
            let tally_mode  = poll.tally_mode || 'approval';
            let entries     = String(data['BALLOT']).split(',').map(e => e.trim()).filter(e => e.length > 0);
            let seen        = {};

            if(entries.length === 0)
                error = 'invalid: BALLOT (empty)';
            if(!error && entries.length > Number(poll.max_selections))
                error = 'invalid: BALLOT (exceeds MAX_SELECTIONS)';

            for(let i = 0; !error && i < entries.length; i++){
                let parts  = entries[i].split(':');
                let choice = Number(parts[0]);
                let share  = (parts.length > 1) ? String(parts[1]).trim() : '1';
                if(!Number.isInteger(choice) || choice < 0 || choice >= optionCount){
                    error = 'invalid: BALLOT (option index out of range)';
                    break;
                }
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

        // MEMO (optional): bounded length
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).length > this.config['MAX_MESSAGE_LENGTH'])
            error = 'invalid: MEMO (length)';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t VOTE ballot : poll " + data['POLL_REF'] + ' : ' + data['STATUS']);

        // Only a VALID ballot mutates the voter's standing ballot; an invalid one
        // is a no-op (leaves any prior valid ballot intact)
        if(!error)
            await this.indexerDb.createBallot(data, selections);

        this.util.addAddressTicker(data['SOURCE']);
        await this.mapper.createMappings(data);
    }

    /*****************************************************************
     * VOTE v2 - finalize poll (system-injected only)
     *
     * Freezes a poll's tally on-chain at its effective close. Triggered by the
     * per-block sweep (util.processVoteFinalizations), never by a user tx: a poll
     * result is a pure deterministic function of already-agreed on-chain state
     * (the votes ledger + getHolders at the close block), so every node computes
     * the same result locally with no consensus round.
     ****************************************************************/
    async _parseFinalize(data, error){
        // System-synthesized only. The decoder accepts VOTE in VALID_ACTION_NAMES,
        // but a user-broadcast VOTE|2 cannot legitimately finalize a poll; reject it
        // (mirrors attest.js:454).
        if(!data['IS_SYNTHETIC']){
            console.warn('\t VOTE v2 : rejected (user-broadcast not allowed for synthetic finalize)');
            data['STATUS'] = 'invalid: VOTE v2 must be system-synthesized';
            return;
        }

        // The poll must still be open. Race-protected: a poll finalized by an
        // earlier trigger this block (e.g. early-decide) is skipped.
        let pollIndex = data['POLL_REF'];
        let poll = await this.indexerDb.getPoll(pollIndex);
        if(this.util.isNull(poll) || poll.poll_status !== 'open')
            return;

        // Synthesized actions arrive without an ACTION_INDEX; allocate one now so
        // poll_results rows and the mappings have a real source (mirrors attest.js).
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({
            ACTION:      'VOTE',
            BLOCK_INDEX: data['BLOCK_INDEX'],
            FORMAT:      2
        }, true);

        data['STATUS'] = 'valid';

        // Compute + freeze the result (reuses getPollTally for the math).
        let result = await this.indexerDb.finalizePoll(data);

        let summary = result
            ? (result.poll_status + (result.fail_reason ? '/' + result.fail_reason : '') +
               ' winner=' + (this.util.isNull(result.winning_option) ? 'none' : result.winning_option) +
               (result.decided_early ? ' (early)' : ''))
            : 'no-op';
        console.log("\t VOTE v2 finalize : poll " + pollIndex + ' @ ' +
                    data['EFFECTIVE_CLOSE_BLOCK'] + ' : ' + summary);

        await this.mapper.createMappings(data);
    }

    /*****************************************************************
     * VOTE v3 - set/clear vote delegation (liquid democracy)
     *
     * A standing, per-token delegation of voting weight to another address. Set
     * once, it applies to every poll governed by TICK until changed or cleared
     * (last-write-wins). A blank DELEGATE_TO clears it. Delegation is resolved at
     * each poll's close (db.getPollTally): one hop, a direct vote overrides it,
     * and the delegator must still hold TICK at close for their weight to flow.
     ****************************************************************/
    async _parseDelegate(data, error){
        let block_index  = parseInt(data['BLOCK_INDEX']);
        let action_index = data['ACTION_INDEX'];

        // TICK must be a real, issued token (the governance electorate)
        if(!error){
            if(this.util.isNull(data['TICK']))
                error = 'invalid: TICK (missing)';
            else {
                let tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], block_index, action_index);
                if(this.util.isNull(tokenInfo))
                    error = 'invalid: TICK (unknown)';
            }
        }

        // DELEGATE_TO is optional: blank = clear (revoke). When set, it cannot be
        // the delegator itself (a self-delegation is meaningless and would let a
        // voter appear to "delegate" while still voting normally).
        let clearing = this.util.isNull(data['DELEGATE_TO']) || String(data['DELEGATE_TO']).trim() === '';
        if(!error && !clearing && String(data['DELEGATE_TO']).trim() === String(data['SOURCE']).trim())
            error = 'invalid: DELEGATE_TO (cannot delegate to self)';

        // MEMO (optional): bounded length
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).length > this.config['MAX_MESSAGE_LENGTH'])
            error = 'invalid: MEMO (length)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t VOTE delegate : " + data['TICK'] + ' -> ' +
                    (clearing ? '(clear)' : data['DELEGATE_TO']) + ' : ' + status);

        // Only a valid action writes a delegation event row.
        if(!error)
            await this.indexerDb.createVoteDelegation(data);

        this.util.addAddressTicker(data['SOURCE'], data['TICK']);
        await this.mapper.createMappings(data);
    }
}

module.exports = Vote;

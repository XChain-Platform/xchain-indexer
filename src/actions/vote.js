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

const { getLogger } = require('../observability/index.js');

// The phases of this handler, in ./vote/. Each part is called with the handler as its
// receiver (fn.call(this, ...)), so the parts read this.indexerDb / this.util /
// this.actions unchanged. What the rest of the indexer and the suites reach through the
// handler (parse, the per-version phases, settleDeposit, processDueCallbacks and
// injectCallbackExecute) stays a real method on Vote.prototype.
const validate        = require('./vote/validate.js');
const bindingCallback = require('./vote/binding_callback.js');
const settle          = require('./vote/settle.js');
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

        // Define list of known FORMATS. v0 create + v1 ballot are user actions; v2
        // finalize is system-injected only (the per-block sweep synthesizes it).
        this.formats = {};
        this.formats[0] = 'VERSION|TICK|END_BLOCK|OPTIONS|MAX_SELECTIONS|TALLY_MODE|WEIGHT_MODE|QUORUM|MIN_VOTERS|MIN_VOTE_BALANCE|DECIDE_THRESHOLD|QUESTION|DEPOSIT|CALLBACK_CONTRACT|CALLBACK_METHOD|CALLBACK_PARAMS|CALLBACK_ON|GAS_ESCROW|CALLBACK_DELAY_BLOCKS';
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
            await this.parseCreate(data, error);
        else if(format===1)
            await this.parseBallot(data, error);
        else if(format===2)
            await this.parseFinalize(data, error);
        else if(format===3)
            await this.parseDelegate(data, error);
    }

    // VOTE v0 - create poll
    async parseCreate(data, error){
        // Apply poll defaults before validation/storage
        if(this.util.isNull(data['MAX_SELECTIONS'])) data['MAX_SELECTIONS'] = '1';
        if(this.util.isNull(data['TALLY_MODE']))     data['TALLY_MODE']     = 'approval';
        if(this.util.isNull(data['WEIGHT_MODE']))    data['WEIGHT_MODE']    = 'balance';

        error = await validate.validateCreateSource.call(this, data, error);
        error = validate.validateCreatePollRules.call(this, data, error);
        error = validate.validateCreateThresholds.call(this, data, error);

        let depositCheck = await validate.validateCreateDeposit.call(this, data, error);
        error = depositCheck.error;

        let callbackCheck = await bindingCallback.validateCreateCallback.call(this, data, error, depositCheck.deposit);
        error = callbackCheck.error;

        // A non-binding poll must not carry callback fields with content.
        if(!error && !callbackCheck.binding && !this.util.isNull(data['GAS_ESCROW']) && this.util.bcgt(String(data['GAS_ESCROW']).trim() || '0', 0))
            error = 'invalid: GAS_ESCROW (set without CALLBACK_CONTRACT)';
        data['GAS_ESCROW']       = callbackCheck.binding ? callbackCheck.gasEscrow : '0';
        data['IS_BINDING']       = callbackCheck.binding;

        await settle.settleCreatePoll.call(this, data, error, depositCheck.deposit);
    }

    // VOTE v1 - cast ballot
    async parseBallot(data, error){
        let pollCheck = await validate.validateBallotPoll.call(this, data, error);
        error = pollCheck.error;

        let ballotCheck = validate.parseBallotSelections.call(this, pollCheck.poll, data, error);
        error = ballotCheck.error;
        let selections = ballotCheck.selections;

        // MEMO (optional): bounded length
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).length > this.config['MAX_MESSAGE_LENGTH'])
            error = 'invalid: MEMO (length)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        getLogger().info("\t VOTE ballot : poll " + data['POLL_REF'] + ' : ' + data['STATUS']);

        // Only a VALID ballot mutates the voter's standing ballot; an invalid one
        // is a no-op (leaves any prior valid ballot intact)
        if(!error)
            await this.indexerDb.createBallot(data, selections);

        this.util.addAddressTicker(data['SOURCE']);
        await this.mapper.createMappings(data);
    }

    // VOTE v2 - finalize poll (system-injected only). Freezes a poll's tally
    // on-chain at its effective close. Triggered by the per-block sweep
    // (util.processVoteFinalizations), never by a user tx: a poll result is a
    // pure deterministic function of already-agreed on-chain state (the votes
    // ledger + getHolders at the close block), so every node computes the same
    // result locally with no consensus round.
    async parseFinalize(data, error){
        // System-synthesized only. The decoder accepts VOTE in VALID_ACTION_NAMES,
        // but a user-broadcast VOTE|2 cannot legitimately finalize a poll; reject it
        // (mirrors attest.js:454).
        if(!data['IS_SYNTHETIC']){
            getLogger().warn('\t VOTE v2 : rejected (user-broadcast not allowed for synthetic finalize)');
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

        // Release any creation deposit per the terminal outcome: refund the creator
        // on a real result, forfeit to the DONATE1 treasury on failed_quorum.
        if(result)
            await this.settleDeposit(poll, data, result.poll_status);

        await bindingCallback.fireBindingCallback.call(this, poll, data, result);

        let summary = result
            ? (result.poll_status + (result.fail_reason ? '/' + result.fail_reason : '') +
               ' winner=' + (this.util.isNull(result.winning_option) ? 'none' : result.winning_option) +
               (result.decided_early ? ' (early)' : ''))
            : 'no-op';
        getLogger().info("\t VOTE v2 finalize : poll " + pollIndex + ' @ ' +
                    data['EFFECTIVE_CLOSE_BLOCK'] + ' : ' + summary);

        await this.mapper.createMappings(data);
    }

    // Release a poll's creation deposit at finalization (body, and the refund or forfeit
    // rule, in ./vote/settle.js). It stays a method because the finalize path reaches it
    // through the handler.
    async settleDeposit(poll, data, terminalStatus){
        return settle.settleDeposit.call(this, poll, data, terminalStatus);
    }

    // Timelock: fire deferred binding callbacks that come due at this block. Called
    // by the per-block sweep (util.processVoteFinalizations). A timelocked poll's
    // v2 stamped callback_due_block = resolved_block + CALLBACK_DELAY_BLOCKS; here
    // the frozen result is reconstructed from the terminal polls row and the
    // callback EXECUTE injected exactly as the immediate path would have at
    // finalize (same EMITTER = the v2's action_index, same savepoint isolation).
    // Fires exactly once: the due query matches only callback_due_block = block,
    // mirroring the immediate path's fire-once-at-v2 semantics. A deterministic
    // callback failure is final on both paths; only a reorg re-fires, since rolling
    // back the due block deletes the EXECUTE generically and rollback.js re-NULLs
    // callback_execute_action_index, so replaying the due block re-fires
    // deterministically.
    async processDueCallbacks(block_index, block_time){
        let due = await this.indexerDb.getDueCallbackPolls(block_index);
        for(let poll of due){
            let result = {
                poll_status:          poll.poll_status,
                winning_option:       poll.winning_option,
                total_counted_weight: poll.total_weight,
                total_voters:         poll.total_voters,
                quorum_met:           !!Number(poll.quorum_met || 0),
                min_voters_met:       !!Number(poll.min_voters_met || 0)
            };
            let data = {
                ACTION:       'VOTE',
                FORMAT:       2,
                BLOCK_INDEX:  block_index,
                BLOCK_TIME:   block_time,
                ACTION_INDEX: poll.finalized_action_index,
                IS_SYNTHETIC: true
            };
            let cbIndex = await this.injectCallbackExecute(poll, data, result);
            if(cbIndex) await this.indexerDb.setPollCallbackIndex(poll.action_index, cbIndex);
        }
    }

    // Binding poll: inject the system EXECUTE that runs the poll's callback. Mirrors
    // ATTEST's synthetic-v2 callback injection. The poll's own result is NOT yet
    // visible to xchain.getPollResult inside the callback (the visibility gate is
    // resolved_block < block, and this fires AT the finalization block), so the
    // result is delivered as positional EXECUTE params the contract reads via
    // xchain.getInputParam(i). The callback runs as the target contract itself
    // (SOURCE = contract address). A callback that reverts, runs out of gas, or
    // throws does NOT un-finalize the poll: the savepoint isolates its effects and
    // the recorded poll result stands.
    async injectCallbackExecute(poll, data, result){
        if(!this.actions.actionExecute) return null;

        let actionParams = await bindingCallback.buildCallbackParams.call(this, poll, data, result);

        let chain = this.config['CHAIN'];
        let emissionActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      'EXECUTE',
            BLOCK_INDEX: data['BLOCK_INDEX'],
            FORMAT:      0,
            SOURCE:      'C:' + chain + ':' + poll.callback_contract_index
        }, true);

        let emissionData = await bindingCallback.buildCallbackContext.call(this, poll, data, chain, emissionActionIndex);

        return await bindingCallback.runCallbackExecute.call(this, poll, actionParams, emissionData, emissionActionIndex);
    }

    // VOTE v3 - set/clear vote delegation (liquid democracy). A standing, per-token
    // delegation of voting weight to another address. Set once, it applies to every
    // poll governed by TICK until changed or cleared (last-write-wins). A blank
    // DELEGATE_TO clears it. Delegation is resolved at each poll's close
    // (db.getPollTally): one hop, a direct vote overrides it, and the delegator
    // must still hold TICK at close for their weight to flow.
    async parseDelegate(data, error){
        let block_index  = parseInt(data['BLOCK_INDEX']);
        let action_index = data['ACTION_INDEX'];

        // Reject a sleeping SOURCE (a frozen address must not set or clear
        // delegations). Gated with the v3 DELEGATE_TO format check below: see
        // VOTE_RESPECTS_SLEEP in protocol_changes.js.
        let tightened = !error && await this.actions.protocolChanges.isEnabled('VOTE_RESPECTS_SLEEP', data['BLOCK_INDEX']);
        if(!error && tightened && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

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

        // A set (non-clearing) DELEGATE_TO must be a real address on this
        // chain, matching MESSAGE/DISPENSER handling. Before the flag-day a
        // malformed target was accepted and just resolved to no holder at tally
        // time, so the check shares the VOTE_RESPECTS_SLEEP gate above.
        if(!error && !clearing && tightened && !this.util.isCryptoAddress(String(data['DELEGATE_TO']).trim()))
            error = 'invalid: DELEGATE_TO (format)';

        // MEMO (optional): bounded length
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).length > this.config['MAX_MESSAGE_LENGTH'])
            error = 'invalid: MEMO (length)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        getLogger().info("\t VOTE delegate : " + data['TICK'] + ' -> ' +
                    (clearing ? '(clear)' : data['DELEGATE_TO']) + ' : ' + status);

        // Only a valid action writes a delegation event row.
        if(!error)
            await this.indexerDb.createVoteDelegation(data);

        this.util.addAddressTicker(data['SOURCE'], data['TICK']);
        await this.mapper.createMappings(data);
    }
}

module.exports = Vote;

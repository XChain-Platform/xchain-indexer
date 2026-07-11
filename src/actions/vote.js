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

const { rethrowIfInfraFault } = require('./faultGuard.js');

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
        this.formats[0] = 'VERSION|TICK|END_BLOCK|OPTIONS|MAX_SELECTIONS|TALLY_MODE|WEIGHT_MODE|QUORUM|MIN_VOTERS|MIN_VOTE_BALANCE|DECIDE_THRESHOLD|QUESTION|DEPOSIT|CALLBACK_CONTRACT|CALLBACK_METHOD|CALLBACK_PARAMS|CALLBACK_ON|GAS_ESCROW';
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

        // DEPOSIT (optional anti-spam escrow, Section 15): GAS the creator locks at
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

        // Binding poll / callback-on-finalize (optional, Section 14): a poll may name
        // a contract method that v2 finalization invokes with the result. Blank
        // CALLBACK_CONTRACT = a signaling poll. When set, the method + firing rule are
        // validated here; GAS_ESCROW (optional XCHAIN) is escrowed below alongside the
        // deposit. Mirrors ATTEST's callback_method / gas_escrow.
        let binding   = !error && !this.util.isNull(data['CALLBACK_CONTRACT']) && String(data['CALLBACK_CONTRACT']).trim() !== '';
        let gasEscrow = '0';
        if(!error && binding){
            if(!this.util.isNumeric(data['CALLBACK_CONTRACT'])){
                error = 'invalid: CALLBACK_CONTRACT (format)';
            } else {
                let contract = await this.indexerDb.getContract(parseInt(data['CALLBACK_CONTRACT']));
                if(this.util.isNull(contract))
                    error = 'invalid: CALLBACK_CONTRACT (unknown contract)';
            }
            // CALLBACK_METHOD required and bounded (matches ATTEST's 64-char cap).
            if(!error && (this.util.isNull(data['CALLBACK_METHOD']) || String(data['CALLBACK_METHOD']).trim() === ''))
                error = 'invalid: CALLBACK_METHOD (required for a binding poll)';
            if(!error && String(data['CALLBACK_METHOD']).length > 64)
                error = 'invalid: CALLBACK_METHOD (length)';
            // CALLBACK_ON: default 'pass' (fire only on a finalized win); 'always'
            // fires on every finalization including failed_quorum.
            if(this.util.isNull(data['CALLBACK_ON'])) data['CALLBACK_ON'] = 'pass';
            if(!error && !['pass','always'].includes(data['CALLBACK_ON']))
                error = 'invalid: CALLBACK_ON (pass|always)';
            // CALLBACK_PARAMS (optional): must be a JSON array if present.
            if(!error && !this.util.isNull(data['CALLBACK_PARAMS']) && String(data['CALLBACK_PARAMS']).trim() !== ''){
                let ok = false;
                try { ok = Array.isArray(JSON.parse(data['CALLBACK_PARAMS'])); } catch(e){ ok = false; }
                if(!ok) error = 'invalid: CALLBACK_PARAMS (must be a JSON array)';
            }
            // GAS_ESCROW (optional): XCHAIN the creator locks to back the callback
            // EXECUTE. Refunded to the creator at finalization (precise gas-cost
            // metering from the escrow is deferred, mirroring ATTEST gas_escrow).
            gasEscrow = this.util.isNull(data['GAS_ESCROW']) ? '0' : String(data['GAS_ESCROW']).trim();
            if(!error && (!this.util.isNumeric(gasEscrow) || this.util.bclt(gasEscrow, 0)))
                error = 'invalid: GAS_ESCROW (non-negative amount)';
            // Funding check covers DEPOSIT + GAS_ESCROW together (both in GAS).
            if(!error && this.util.bcgt(gasEscrow, 0)){
                let need     = this.util.bcadd(deposit, gasEscrow, 8);
                let gasInfo  = await this.indexerDb.getTokenInfo(gas, block_index, action_index);
                let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, block_index, action_index);
                if(!gasInfo || !this.util.hasBalance(balances, gasInfo['TICK_ID'], need))
                    error = 'invalid: insufficient funds (GAS_ESCROW)';
            }
        }
        // A non-binding poll must not carry callback fields with content.
        if(!error && !binding && !this.util.isNull(data['GAS_ESCROW']) && this.util.bcgt(String(data['GAS_ESCROW']).trim() || '0', 0))
            error = 'invalid: GAS_ESCROW (set without CALLBACK_CONTRACT)';
        data['GAS_ESCROW']       = binding ? gasEscrow : '0';
        data['IS_BINDING']       = binding;

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t VOTE create : " + data['TICK'] + ' : ' + data['STATUS']);

        // Persist the poll only when valid; an invalid create writes no poll row
        // (the action itself is still recorded in `actions` with its status)
        if(!error)
            await this.indexerDb.createPoll(data);

        // Escrow the creator's locked GAS (deposit + any binding-poll gas_escrow)
        // at this v0 action_index; released by VOTE v2 finalize. One combined escrow
        // row (both are GAS from SOURCE); v2 routes the credits per kind. Same generic
        // ledger path as ATTEST's fee escrow, so rollback deletes by action_index.
        let lockTotal = this.util.bcadd(deposit, data['GAS_ESCROW'], 8);
        if(!error && this.util.bcgt(lockTotal, 0)){
            this.util.addAddressTicker(data['SOURCE'], gas);
            let debits  = [[gas, lockTotal, data['SOURCE']]];
            let escrows = [[gas, lockTotal, data['SOURCE']]];
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, [], debits, escrows);
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);
        }

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

        // Release any creation deposit per the terminal outcome: refund the creator
        // on a real result, forfeit to the DONATE1 treasury on failed_quorum.
        if(result)
            await this._settleDeposit(poll, data, result.poll_status);

        // Binding poll (Section 14): fire the contract callback when its CALLBACK_ON
        // gate is met - 'always' on any finalization, 'pass' only on a finalized win.
        // A failed callback does NOT un-finalize the poll (see _injectCallbackExecute).
        if(result && !this.util.isNull(poll.callback_contract_index)){
            let fires = (poll.callback_on === 'always') ||
                        (result.poll_status === 'finalized' && !this.util.isNull(result.winning_option));
            if(fires){
                let cbIndex = await this._injectCallbackExecute(poll, data, result);
                if(cbIndex) await this.indexerDb.setPollCallbackIndex(poll.action_index, cbIndex);
            }
        }

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
     * Release a poll's creation deposit at finalization.
     *
     * Refunds the escrowed GAS to the creator on a real outcome ('finalized'), or
     * forfeits it to the DONATE1 treasury when the poll dies for lack of
     * participation ('failed_quorum'). A negative escrow row releases the hold (the
     * order_expire / attest_settle idiom); the matching credit routes the funds.
     * No-op when the poll carried no deposit. deposit_resolved records the outcome
     * so a reprocessed finalize cannot double-release.
     ****************************************************************/
    async _settleDeposit(poll, data, terminalStatus){
        let deposit   = String((poll && poll.deposit_amount) || '0');
        let gasEscrow = String((poll && poll.gas_escrow) || '0');
        let held      = this.util.bcadd(deposit, gasEscrow, 8); // combined v0 escrow
        if(!this.util.bcgt(held, '0')) return;
        if(!this.util.isNull(poll.deposit_resolved)) return; // already released

        let creator = await this.indexerDb.getAddressById(poll.deposit_address_id);
        if(this.util.isNull(creator)){
            console.warn('\t VOTE escrow : missing creator for poll ' + poll.action_index + ', escrow left held');
            return;
        }

        let gas       = this.config['GAS'];
        let refunded  = (terminalStatus !== 'failed_quorum');
        // Release the whole v0 hold (one negative escrow row) and route the credits:
        // the deposit refunds the creator on a finalized win or forfeits to DONATE1 on
        // failed_quorum; the gas_escrow ALWAYS refunds the creator (the callback's
        // backing, not at risk). Precise gas-cost metering is deferred (ATTEST parity).
        let escrows = [[gas, this.util.bcmul(held, '-1', 8), creator]];
        let credits = [];
        this.util.addAddressTicker(creator, gas);
        if(this.util.bcgt(deposit, '0')){
            let depTarget = refunded ? creator : this.config['ADDRESS']['DONATE1'];
            this.util.addAddressTicker(depTarget, gas);
            credits.push([gas, deposit, depTarget]);
        }
        if(this.util.bcgt(gasEscrow, '0'))
            credits.push([gas, gasEscrow, creator]);

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, [], escrows);
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);
        await this.indexerDb.setPollDepositResolved(poll.action_index, refunded ? 'refunded' : 'forfeited');

        console.log("\t VOTE escrow : poll " + poll.action_index + ' released ' + held + ' ' + gas +
                    ' (deposit ' + deposit + (refunded ? ' refund' : ' forfeit') + ', gas_escrow ' + gasEscrow + ' refund)');
    }

    /*****************************************************************
     * Binding poll: inject the system EXECUTE that runs the poll's callback.
     *
     * Mirrors ATTEST's synthetic-v2 callback injection. The poll's own result is
     * NOT yet visible to xchain.getPollResult inside the callback (the visibility
     * gate is resolved_block < block, and this fires AT the finalization block), so
     * the result is delivered as positional EXECUTE params the contract reads via
     * xchain.getInputParam(i). The callback runs as the target contract itself
     * (SOURCE = contract address). A callback that reverts, runs out of gas, or
     * throws does NOT un-finalize the poll: the savepoint isolates its effects and
     * the recorded poll result stands.
     ****************************************************************/
    async _injectCallbackExecute(poll, data, result){
        if(!this.actions.actionExecute) return null;

        let callbackParams = [];
        if(poll.callback_params){
            try { let parsed = JSON.parse(poll.callback_params); if(Array.isArray(parsed)) callbackParams = parsed; }
            catch(e){ callbackParams = []; }
        }

        // Callback signature: [pollIndex, status, winning_option, total_weight,
        // total_voters, quorum_met, min_voters_met, ...originalCallbackParams].
        let callbackArgs = [
            String(poll.action_index),
            String(result.poll_status),
            this.util.isNull(result.winning_option) ? '' : String(result.winning_option),
            String(this.util.isNull(result.total_counted_weight) ? '0' : result.total_counted_weight),
            String(this.util.isNull(result.total_voters) ? '0' : result.total_voters),
            result.quorum_met ? '1' : '0',
            result.min_voters_met ? '1' : '0',
            ...callbackParams.map(String)
        ];

        // Positional EXECUTE format: VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...
        let actionParams = [0, poll.callback_contract_index, poll.callback_method, ...callbackArgs];

        let chain = this.config['CHAIN'];
        let emissionActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      'EXECUTE',
            BLOCK_INDEX: data['BLOCK_INDEX'],
            FORMAT:      0,
            SOURCE:      'C:' + chain + ':' + poll.callback_contract_index
        }, true);

        let emissionData = {
            ACTION_INDEX: emissionActionIndex,
            SOURCE:       'C:' + chain + ':' + poll.callback_contract_index,
            FEE_PAYER:    'C:' + chain + ':' + poll.callback_contract_index,
            BLOCK_INDEX:  data['BLOCK_INDEX'],
            BLOCK_TIME:   data['BLOCK_TIME'],
            FORMAT:       0,
            IS_EMISSION:  true,
            EMITTER:      data['ACTION_INDEX']
        };

        let savepoint = await this.indexerDb.createSavepoint('vote_callback_' + parseInt(poll.action_index));
        try {
            await this.actions.actionExecute.parse(actionParams, emissionData, null);
            if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid')
                console.warn('\t VOTE callback : execute non-valid (' + emissionData['STATUS'] + '), poll result stands');
            await this.indexerDb.releaseSavepoint(savepoint);
            console.log("\t VOTE callback : poll " + poll.action_index + ' -> contract ' +
                        poll.callback_contract_index + '.' + poll.callback_method + ' (execute ' + emissionActionIndex + ')');
            return emissionActionIndex;
        } catch(e){
            // A throwing callback must not brick the finalized result: roll back only
            // the callback's effects and keep the poll terminal.
            await this.indexerDb.rollbackToSavepoint(savepoint);
            // An infrastructure fault (VM host fault, transient DB error) is not a
            // callback outcome: halt so the block rolls back and retries rather than
            // committing this validator's poll with a silently-dropped callback while
            // healthy peers apply it. A deterministic callback failure still stands.
            rethrowIfInfraFault(e);
            console.warn('\t VOTE callback : execute threw (' + e.message + '), poll result stands');
            return null;
        }
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

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
 * XChain Platform Action - VOTE : binding-poll callback
 *
 * Both ends of a binding poll's contract callback: at create (v0) the checks on
 * the CALLBACK_* fields and GAS_ESCROW, and at finalization (v2) the decision to
 * fire, the positional arguments, the injected execution context and the
 * savepointed EXECUTE run. Called with the VOTE handler as `this` (see
 * ../vote.js); the injection itself stays the handler's injectCallbackExecute,
 * which the per-block timelock sweep calls too.
 *
 ********************************************************************/

'use strict';

const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');
const { buildInjectedExecContext, SYNTH_EXEC_TX_HASH, SYNTH_TAGS } = require('../../consensus/exec_context.js');
const { getLogger } = require('../../observability/index.js');

// Declare the fixed finalization slots that open every callback's params, in wire order.
const POLL_CALLBACK_FIXED_SLOTS = Object.freeze([
    'pollIndex', 'status', 'winningOption', 'totalWeight', 'totalVoters', 'quorumMet', 'minVotersMet'
]);
// Name the slot spliced after the fixed slots while VOTE_POLL_TICK_VISIBLE is active.
const POLL_CALLBACK_TICK_SLOT = 'tick';

// Binding poll / callback-on-finalize (optional): a poll may name
// a contract method that v2 finalization invokes with the result. Blank
// CALLBACK_CONTRACT = a signaling poll. When set, the method + firing rule are
// validated here; GAS_ESCROW (optional XCHAIN) is escrowed below alongside the
// deposit. Mirrors ATTEST's callback_method / gas_escrow.
async function validateCreateCallback(data, error, deposit){
    let binding   = !error && !this.util.isNull(data['CALLBACK_CONTRACT']) && String(data['CALLBACK_CONTRACT']).trim() !== '';
    let gasEscrow = '0';
    if(!error && binding){
        error = await validateCallbackTarget.call(this, data, error);
        error = await validateCallbackPolicy.call(this, data, error);
        let escrowCheck = await validateCallbackEscrow.call(this, data, error, deposit);
        error     = escrowCheck.error;
        gasEscrow = escrowCheck.gasEscrow;
    }
    return { error: error, binding: binding, gasEscrow: gasEscrow };
}

// Binding-poll phase - the callback target itself: which contract, which method, and
// on which finalization outcome it fires.
async function validateCallbackTarget(data, error){
    // CALLBACK_CONTRACT names a contract by its numeric index, not an address, and
    // the contract has to exist now: a poll cannot bind to something deployed later.
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
    // The 64-character cap: CALLBACK_METHOD is stored on the poll row and replayed
    // verbatim into the injected EXECUTE, so it has to fit that action's method field.
    if(!error && String(data['CALLBACK_METHOD']).length > 64)
        error = 'invalid: CALLBACK_METHOD (length)';
    // CALLBACK_ON: default 'pass' (fire only on a finalized win); 'always'
    // fires on every finalization including failed_quorum.
    if(this.util.isNull(data['CALLBACK_ON'])) data['CALLBACK_ON'] = 'pass';
    // Only the two documented triggers are accepted. An unknown value would have to
    // be given a meaning at finalize time, and two nodes could choose differently.
    if(!error && !['pass','always'].includes(data['CALLBACK_ON']))
        error = 'invalid: CALLBACK_ON (pass|always)';
    return error;
}

// Binding-poll phase - the policy a binding poll must satisfy: the turnout floors, the
// optional timelock, and the positional callback parameters.
async function validateCallbackPolicy(data, error){
    // At/after the VOTE_BINDING_MINIMUMS flag-day a binding poll must set its
    // own turnout floor (closes a low-turnout-hijack class of guard). QUORUM and
    // MIN_VOTERS >= 1 are required so a callback that can move
    // contract-held value can never finalize off a handful of ballots
    // by omission; their magnitudes stay the creator's policy call.
    // Signaling polls are unaffected. See protocol_changes.js for why
    // the requirement is gated (validity tightening).
    if(!error && await this.actions.protocolChanges.isEnabled('VOTE_BINDING_MINIMUMS', data['BLOCK_INDEX'])){
        if(this.util.isNull(data['QUORUM']))
            error = 'invalid: QUORUM (required for a binding poll)';
        else if(this.util.isNull(data['MIN_VOTERS']) || Number(data['MIN_VOTERS']) < 1)
            error = 'invalid: MIN_VOTERS (>= 1 required for a binding poll)';
    }
    // CALLBACK_DELAY_BLOCKS (optional timelock). Honored only
    // at/after the VOTE_CALLBACK_TIMELOCK flag-day; below it the field
    // is nulled so acceptance and callback timing match a legacy node,
    // whose parser drops params beyond its format. See
    // protocol_changes.js for the fork rationale.
    if(await this.actions.protocolChanges.isEnabled('VOTE_CALLBACK_TIMELOCK', data['BLOCK_INDEX'])){
        if(!error && !this.util.isNull(data['CALLBACK_DELAY_BLOCKS'])){
            let cbd = Number(data['CALLBACK_DELAY_BLOCKS']);
            // The delay is added to the resolve block to stamp callback_due_block, so a
            // fractional or negative value would put the due block in the past or off-grid.
            if(!Number.isInteger(cbd) || cbd < 0)
                error = 'invalid: CALLBACK_DELAY_BLOCKS (non-negative integer)';
        }
    } else {
        data['CALLBACK_DELAY_BLOCKS'] = null;
    }
    // CALLBACK_PARAMS (optional): must be a JSON array if present.
    if(!error && !this.util.isNull(data['CALLBACK_PARAMS']) && String(data['CALLBACK_PARAMS']).trim() !== ''){
        let ok = false;
        try { ok = Array.isArray(JSON.parse(data['CALLBACK_PARAMS'])); } catch(e){ ok = false; }
        // CALLBACK_PARAMS is handed to the contract as positional EXECUTE arguments, so it
        // must be an array; an object or a bare scalar has no positional reading.
        if(!ok) error = 'invalid: CALLBACK_PARAMS (must be a JSON array)';
    }
    return error;
}

// Binding-poll phase - GAS_ESCROW: the optional callback backing, funded alongside the
// deposit. Returns the error and the normalized escrow amount.
async function validateCallbackEscrow(data, error, deposit){
    let block_index  = parseInt(data['BLOCK_INDEX']);
    let action_index = data['ACTION_INDEX'];
    let gas          = this.config['GAS'];
    let gasEscrow    = '0';

    // GAS_ESCROW (optional): XCHAIN the creator locks to back the callback
    // EXECUTE. Refunded to the creator at finalization (precise gas-cost
    // metering from the escrow is deferred, mirroring ATTEST gas_escrow).
    gasEscrow = this.util.isNull(data['GAS_ESCROW']) ? '0' : String(data['GAS_ESCROW']).trim();
    // Verify GAS_ESCROW is a non-negative amount
    if(!error && (!this.util.isNumeric(gasEscrow) || this.util.bclt(gasEscrow, 0)))
        error = 'invalid: GAS_ESCROW (non-negative amount)';
    // Funding check covers DEPOSIT + GAS_ESCROW together (both in GAS).
    if(!error && this.util.bcgt(gasEscrow, 0)){
        let need     = this.util.bcadd(deposit, gasEscrow, 8);
        let gasInfo  = await this.indexerDb.getTokenInfo(gas, block_index, action_index);
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, block_index, action_index);
        // GAS_ESCROW is locked at creation, so this funding read is taken at
        // (block, action) for the same reason the DEPOSIT read above is: two validators
        // reading at different points would disagree on accept/reject.
        if(!gasInfo || !this.util.hasBalance(balances, gasInfo['TICK_ID'], need))
            error = 'invalid: insufficient funds (GAS_ESCROW)';
    }
    return { error: error, gasEscrow: gasEscrow };
}

// VOTE v2 phase - the binding poll's callback decision at finalization: whether the
// CALLBACK_ON gate fires at all, and whether it fires now or is stamped as due later.
async function fireBindingCallback(poll, data, result){
    // Binding poll: fire the contract callback when its CALLBACK_ON
    // gate is met - 'always' on any finalization, 'pass' only on a finalized win.
    // A failed callback does NOT un-finalize the poll (see injectCallbackExecute).
    if(result && !this.util.isNull(poll.callback_contract_index)){
        let fires = (poll.callback_on === 'always') ||
                    (result.poll_status === 'finalized' && !this.util.isNull(result.winning_option));
        if(fires){
            // Timelock: a poll created with CALLBACK_DELAY_BLOCKS > 0
            // (only storable at/after the VOTE_CALLBACK_TIMELOCK flag-day)
            // freezes its tally and settles its deposit now, but the callback
            // EXECUTE is deferred to this block + delay; the per-block sweep
            // (processDueCallbacks) fires it there. State-driven, so replay is
            // deterministic without re-evaluating the gate here.
            let cbDelay = Number(poll.callback_delay_blocks || 0);
            if(Number.isInteger(cbDelay) && cbDelay > 0){
                let dueBlock = parseInt(data['BLOCK_INDEX']) + cbDelay;
                await this.indexerDb.setPollCallbackDue(poll.action_index, dueBlock);
                getLogger().info("\t VOTE callback : poll " + poll.action_index + ' timelocked, due at block ' + dueBlock);
            } else {
                let cbIndex = await this.injectCallbackExecute(poll, data, result);
                if(cbIndex) await this.indexerDb.setPollCallbackIndex(poll.action_index, cbIndex);
            }
        }
    }

}

// Binding-callback phase - build the positional EXECUTE arguments the contract reads,
// from the poll's stored callback params and the frozen result.
async function buildCallbackParams(poll, data, result){
    let callbackParams = [];
    if(poll.callback_params){
        try { let parsed = JSON.parse(poll.callback_params); if(Array.isArray(parsed)) callbackParams = parsed; }
        catch(e){ callbackParams = []; }
    }

    // At/after the VOTE_POLL_TICK_VISIBLE flag-day the poll's
    // electorate TICK is delivered to the callback (inserted after
    // min_voters_met, before the developer params) so a binding-poll
    // contract can verify WHICH token decided it (e.g. treasury.arm()
    // pins poll.tick === govTick). Below the flag-day the signature is
    // byte-identical to the pre-flag layout (no tick slot). The tick is
    // NOT visible via xchain.getPollResult inside the callback (the
    // visibility gate is resolved_block < block and this fires AT the
    // finalization block), which is exactly why it rides the positional
    // params like the rest of the result.
    let tickVisible = await this.actions.protocolChanges.isEnabled('VOTE_POLL_TICK_VISIBLE', data['BLOCK_INDEX']);
    let tickArg = [];
    if(tickVisible){
        let tick = this.util.isNull(poll.tick_id) ? '' : await this.indexerDb.getTicker(poll.tick_id);
        tickArg = [String(this.util.isNull(tick) ? '' : tick)];
    }

    // Callback signature: [pollIndex, status, winning_option, total_weight,
    // total_voters, quorum_met, min_voters_met, (tick,)? ...originalCallbackParams].
    // Keep it in step with POLL_CALLBACK_FIXED_SLOTS: contract templates pin their arity to it.
    let callbackArgs = [
        String(poll.action_index),
        String(result.poll_status),
        this.util.isNull(result.winning_option) ? '' : String(result.winning_option),
        String(this.util.isNull(result.total_counted_weight) ? '0' : result.total_counted_weight),
        String(this.util.isNull(result.total_voters) ? '0' : result.total_voters),
        result.quorum_met ? '1' : '0',
        result.min_voters_met ? '1' : '0',
        ...tickArg,
        ...callbackParams.map(String)
    ];

    // Positional EXECUTE format: VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...
    let actionParams = [0, poll.callback_contract_index, poll.callback_method, ...callbackArgs];

    return actionParams;
}

// Binding-callback phase - build the injected execution context the EXECUTE runs in.
async function buildCallbackContext(poll, data, chain, emissionActionIndex){
    // The finalize/timelock callback has no real tx behind it (VOTE v2
    // is system-synthesized). Post-SYNTH_EXEC_TX_HASH the context gets a
    // deterministic synthetic TX_HASH (namespaced by the poll's action_index,
    // unique per poll since the callback fires exactly once), so an ATTEST/XCALL
    // the callback emits derives a resolvable id instead of being billed and
    // hard-rejected. Below the flag-day the legacy hashless context is
    // reproduced byte-identically (consensus replay safety).
    let synthActive = await this.actions.protocolChanges.isEnabled(SYNTH_EXEC_TX_HASH, data['BLOCK_INDEX']);
    let emissionData = buildInjectedExecContext({
        chain:         chain,
        network:       this.config['NETWORK'],
        contractIndex: poll.callback_contract_index,
        actionIndex:   emissionActionIndex,
        blockIndex:    data['BLOCK_INDEX'],
        blockTime:     data['BLOCK_TIME'],
        emitter:       data['ACTION_INDEX'],
        synthTag:      SYNTH_TAGS.VOTE_CALLBACK,
        synthId:       poll.action_index,
        includeTxHash: synthActive
    });

    return emissionData;
}

// Binding-callback phase - run the injected EXECUTE inside its own savepoint, so a
// callback that fails or throws cannot un-finalize the poll.
async function runCallbackExecute(poll, actionParams, emissionData, emissionActionIndex){
    let savepoint = await this.indexerDb.createSavepoint('vote_callback_' + parseInt(poll.action_index));
    try {
        await this.actions.actionExecute.parse(actionParams, emissionData, null);
        if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid')
            getLogger().warn('\t VOTE callback : execute non-valid (' + emissionData['STATUS'] + '), poll result stands');
        await this.indexerDb.releaseSavepoint(savepoint);
        getLogger().info("\t VOTE callback : poll " + poll.action_index + ' -> contract ' +
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
        getLogger().warn('\t VOTE callback : execute threw (' + e.message + '), poll result stands');
        return null;
    }
}

module.exports = {
    validateCreateCallback, validateCallbackTarget, validateCallbackPolicy, validateCallbackEscrow,
    fireBindingCallback, buildCallbackParams, buildCallbackContext, runCallbackExecute,
    POLL_CALLBACK_FIXED_SLOTS, POLL_CALLBACK_TICK_SLOT
};

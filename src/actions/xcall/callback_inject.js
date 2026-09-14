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
 * The callback EXECUTE that delivers a cross-chain call outcome back to the
 * requesting contract. One writer for both outcomes: the result pass and the
 * deadline-expiry path call the same code, so an 'expired' callback and an 'ok'
 * callback cannot drift apart on argument order, gas ceiling or savepoint
 * handling.
 *
 * Called with the handler as `this` (index.js delegates with .call).
 *
 ********************************************************************/

'use strict';

const { buildInjectedExecContext, SYNTH_TAGS } = require('../../consensus/exec_context.js');
const { getLogger } = require('../../observability/index.js');

// Callback ceiling: read from the gas schedule so it stays in sync with
// the VM_XCALL_CALLBACK amount charged at emit time (gateway-emit.js crossExecute).
// Hard-fail on a missing or non-positive value: a silent default would allow the
// injected ceiling to diverge from the amount the VM charged at emit time if the
// schedule is misconfigured, producing an ok/out_of_gas split across validators.
function callbackGasCeiling(){
    let schedule = (this.config && this.config['GAS_SCHEDULE']) || {};
    let xcallCallbackGasRaw = schedule['VM_XCALL_CALLBACK'];
    let xcallCallbackGasVal = parseInt(xcallCallbackGasRaw, 10);
    if(xcallCallbackGasRaw === undefined || xcallCallbackGasRaw === null || !Number.isInteger(xcallCallbackGasVal) || xcallCallbackGasVal <= 0 || String(xcallCallbackGasRaw).trim() !== String(xcallCallbackGasVal)){
        throw new Error('GAS_SCHEDULE.VM_XCALL_CALLBACK missing or invalid (expected a positive integer, got ' + JSON.stringify(xcallCallbackGasRaw) + ')');
    }
    return xcallCallbackGasVal;
}

// Positional EXECUTE params for the callback:
// VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS..., where the leading callback
// arguments are the fixed outcome tuple
// (call_id, target_chain, status, return_payload) and the developer's own
// CALLBACK_PARAMS follow it.
function callbackActionParams(request, resultStatus, resultPayload){
    let callbackParams = [];
    if(request.callback_params_json){
        try {
            let parsed = JSON.parse(request.callback_params_json);
            if(Array.isArray(parsed)) callbackParams = parsed;
        } catch(_){
            callbackParams = [];
        }
    }

    let callbackArgs = [
        request.call_id,
        String(request.target_chain || ''),
        String(resultStatus),
        String(resultPayload == null ? '' : resultPayload),
        ...callbackParams.map(String)
    ];

    // Positional EXECUTE format: VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...
    return [
        0,
        request.contract_index,
        request.callback_method,
        ...callbackArgs
    ];
}

// Synthesize the callback EXECUTE delivering a cross-chain call outcome to the
// requesting contract. Shared by the result pass (utility.processCrossChainCalls)
// and the expiry path (expire.js). Runs under the fixed callback gas ceiling the caller
// pre-paid at emit time, inside its own savepoint; a failing callback never rolls
// back the result/expiry bookkeeping. Returns the callback EXECUTE's action_index.
//
// Callback signature: callbackMethod(call_id, target_chain, status, return_payload, ...callbackParams)
async function injectCallback(request, contextData, resultStatus, resultPayload){
    if(!this.actions.actionExecute) return null;

    const XCALL_CALLBACK_GAS = callbackGasCeiling.call(this);

    let actionParams = callbackActionParams(request, resultStatus, resultPayload);

    let chain = this.config['CHAIN'];
    let emissionActionIndex = await this.indexerDb.createActionIndex({
        ACTION:      'EXECUTE',
        BLOCK_INDEX: contextData['BLOCK_INDEX'],
        FORMAT:      0,
        SOURCE:      'C:' + chain + ':' + request.contract_index
    }, true);

    // SOURCE = contract address (ATTEST callback precedent). The synthetic TX_HASH
    // ('XCALLCB' tag, live consensus, byte-identical to the legacy inline
    // synthesis it replaced) is chain/network-namespaced so anything the callback itself emits
    // (ATTEST, emit.execute, crossExecute) derives collision-free ids. CROSS_HOPS
    // carries the call's hop count into the callback context so a contract reacting
    // to a callback by calling out again stays inside the hop budget.
    let emissionData = buildInjectedExecContext({
        chain:         chain,
        network:       this.config['NETWORK'],
        contractIndex: request.contract_index,
        actionIndex:   emissionActionIndex,
        blockIndex:    contextData['BLOCK_INDEX'],
        blockTime:     contextData['BLOCK_TIME'],
        emitter:       contextData['ACTION_INDEX'],
        synthTag:      SYNTH_TAGS.XCALL_CALLBACK,
        synthId:       request.call_id,
        extra: {
            CALL_DEPTH:   0,
            VM_GAS_LIMIT: XCALL_CALLBACK_GAS,
            CROSS_HOPS:   Number(request.cross_hops) || 0
        }
    });

    let savepoint = await this.indexerDb.createSavepoint('xcall_callback_' + emissionActionIndex);
    try {
        await this.actions.actionExecute.parse(actionParams, emissionData, null);
        if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid'){
            getLogger().warn('XCALL callback execute returned non-valid status: ' + emissionData['STATUS']);
        }
        await this.indexerDb.releaseSavepoint(savepoint);
        return emissionActionIndex;
    } catch(e){
        await this.indexerDb.rollbackToSavepoint(savepoint);
        throw e;
    }
}

module.exports = { injectCallback };

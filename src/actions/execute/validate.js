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
 * XChain Platform Action - EXECUTE : pre-VM validation
 *
 * The rejections an EXECUTE can earn before any gas is priced or the VM is
 * reached: the wire format, the contract reference and the contract's state.
 * Called with the EXECUTE handler as `this` (see ./index.js), so the body
 * reads this.util, this.indexerDb and this.actions exactly as it did when it
 * was inline in parse().
 *
 ********************************************************************/

'use strict';

// Host-side assert: post-SYNTH_EXEC_TX_HASH every injected/emitted
// execution context MUST carry a TX_HASH (real or synthesized via
// consensus/exec_context.js). A hashless context reaching the VM silently
// strands anything the contract emits (the VM derives a request_id, gas is
// charged, then the indexer hard-rejects the emission), so a regressing
// injector site is an infrastructure bug, not a contract outcome: throw a
// fault-classed error that faultGuard propagates, halting the block loudly
// instead of committing the stranding. Pre-activation the two legacy
// hashless sites are still live, so the assert stays dark (replay safety).
async function assertExecContextTxHash(data, synthExecTxHash){
    if(data['IS_EMISSION'] && !data['TX_HASH'] &&
       await this.actions.protocolChanges.isEnabled(synthExecTxHash, data['BLOCK_INDEX'])){
        let fault = new Error('EXECUTE injected without TX_HASH (SYNTH_EXEC_TX_HASH active): ' +
            'injector sites must build their context via consensus/exec_context.js');
        fault.code = 'EXEC_CONTEXT_TX_HASH_MISSING';
        throw fault;
    }
}

/*****************************************************************
 * Contract Validations
 ****************************************************************/

// The wire-format half: the FORMAT, the positional params it carries, and the
// shape of the two fields that name what is being executed. Records the first
// rejection on ctx.error; every later check reads it and stands down.
async function validateExecuteFields(ctx, params){
    let data = ctx.data;

    // Validate that format is known
    let format = data['FORMAT'];
    if(!ctx.error && (format===null || this.formats[format] === undefined ))
        ctx.error = 'invalid: VERSION (unknown)';

    // Extract params
    data['CONTRACT_ACTION_INDEX'] = params[1];
    data['METHOD']                = params[2];
    // Remaining params are method arguments
    data['METHOD_PARAMS']         = params.slice(3).join('|');

    // Convert NUMBER fields from string value to number value
    if(!ctx.error)
        ctx.data = data = this.util.setNumberFormats(data);

    // Verify CONTRACT_ACTION_INDEX is provided
    if(!ctx.error && this.util.isNull(data['CONTRACT_ACTION_INDEX']))
        ctx.error = 'invalid: CONTRACT_ACTION_INDEX (required)';

    // Verify CONTRACT_ACTION_INDEX is a canonical integer index (see deposit.js).
    // Host-derived reentrant calls (emitted EXECUTE / XEXEC) pass integer indexes,
    // which String() renders canonically, so this only rejects malformed wire input.
    // Gated by CONTRACT_INDEX_CANONICAL (the same flag-day STAKE/UNSTAKE/DELEGATE
    // use): at/after it a non-canonical wire index ('007') or one past the safe-integer
    // range is rejected here. The VM hashes Number(contractIndex) into the attestation
    // request_id preimage (xchain-vm/gateway.js) while the host re-hashes the raw EMITTER
    // string (attest.js), so a non-canonical index makes the two disagree and the host
    // rejects an ATTEST the VM already accepted. Below the flag-day the legacy /^\d+$/ is
    // preserved so historical blocks replay byte-identically.
    if(!ctx.error){
        let idxRaw    = String(data['CONTRACT_ACTION_INDEX']);
        let canonical = await this.actions.protocolChanges.isEnabled('CONTRACT_INDEX_CANONICAL', data['BLOCK_INDEX']);
        let idxBad    = canonical
            ? (!/^[1-9]\d*$/.test(idxRaw) || Number(idxRaw) > Number.MAX_SAFE_INTEGER)
            : !/^\d+$/.test(idxRaw);
        if(idxBad)
            ctx.error = 'invalid: CONTRACT_ACTION_INDEX (format)';
    }

    // Verify METHOD is provided
    if(!ctx.error && this.util.isNull(data['METHOD']))
        ctx.error = 'invalid: METHOD (required)';
}

// The contract half: the row must exist and be active. ctx.contractInfo is what
// the VM phase runs (its code) and what the settlement phase's "did the VM run"
// conditions read, so a rejection here leaves it null on purpose.
async function loadExecuteContract(ctx){
    let data = ctx.data;

    // Verify contract exists and is active
    if(!ctx.error){
        ctx.contractInfo = await this.indexerDb.getContract(data['CONTRACT_ACTION_INDEX']);
        if(!ctx.contractInfo)
            ctx.error = 'invalid: CONTRACT_ACTION_INDEX (unknown)';
    }

    // Verify contract is valid/active
    if(!ctx.error && ctx.contractInfo){
        let contractStatus = await this.indexerDb.getStatusString(ctx.contractInfo.status_id);
        if(contractStatus !== 'valid')
            ctx.error = 'invalid: contract (not active)';
    }
}

// Both halves in the order parse() ran them: a field rejection wins over a
// contract rejection, because the lookup never runs once ctx.error is set.
async function validateExecute(ctx, params){
    await validateExecuteFields.call(this, ctx, params);
    await loadExecuteContract.call(this, ctx);
}

// Runs AFTER the fee phase, where parse() has always run it: a sleeping SOURCE
// is rejected only once the fee checks above have had their say, so the status a
// sleeping-and-underfunded source earns does not depend on the order here.
async function validateSourceAwake(ctx){
    let data = ctx.data;

    // Verify SOURCE is not sleeping
    if(!ctx.error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        ctx.error = 'invalid: SOURCE (sleeping)';
}

module.exports = { assertExecContextTxHash, validateExecute, validateSourceAwake };

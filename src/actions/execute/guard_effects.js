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
 * XChain Platform Action - EXECUTE : controller-guard commit
 *
 * What an ALLOWING guard leaves behind: its state writes, the parent execution
 * row its emissions join to in the block contract_hash preimage, and the
 * emissions themselves, all inside one savepoint so a failure denies the
 * guarded action instead of half-applying. Called with the EXECUTE handler as
 * `this` and the guard ctx built in ./controller_guard.js.
 *
 ********************************************************************/

'use strict';

const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');

// The emission context a guard's own emissions run under.
function buildGuardEmissionContext(ctx){
    let hostData = ctx.hostData;
    return {
        ACTION_INDEX:          hostData['ACTION_INDEX'],
        // Root discriminator for this guard's emission subtree = the guarded native action's
        // on-chain output index TX_VOUT, under the ROOT_ACTION_INDEX key attest.js/xcall.js
        // read (propagated unchanged by processEmission). MUST be the identical value the
        // guard's own vm.execute above was given, BATCH_POSITION suffix included, or the
        // guard's emissions re-derive against a different root than the VM hashed.
        ROOT_ACTION_INDEX:     ctx.guardRootDiscrim,
        CONTRACT_ACTION_INDEX: ctx.contractIndex,
        SOURCE:                ctx.derived,
        BLOCK_INDEX:           hostData['BLOCK_INDEX'],
        BLOCK_TIME:            hostData['BLOCK_TIME'],
        TX_INDEX:              hostData['TX_INDEX'],
        TX_HASH:               hostData['TX_HASH'],
        TX_VOUT:               hostData['TX_VOUT'],
        CALL_DEPTH:            ctx.callDepth,
        CROSS_HOPS:            0,
        // Mark emissions from this guard run so they are not themselves re-guarded by their
        // OWN controller (no guard-of-guard): see Utility.maybeRunControllerGuard. They still
        // carry IS_EMISSION (fee already skipped) and depth-cap on cross-controlled-token moves.
        IS_GUARD_EMISSION:     true,
        // Guard emissions draw from the guarded TRANSACTION's issuance budget too
        // (EMISSION_ISSUANCE_LIMITS): a controller guard is another VM path to
        // the ISSUE handler, so leaving it off this context would leave the hole open on
        // the one emission path that runs without an EXECUTE at all.
        ISSUANCE_LIMIT_LEDGER: hostData['ISSUANCE_LIMIT_LEDGER']
    };
}

async function writeGuardState(ctx){
    let hostData = ctx.hostData;
    for(let change of ctx.vmResult.stateChanges){
        await this.indexerDb.createContractState({
            CONTRACT_INDEX: ctx.contractIndex,
            STATE_KEY:      change.key,
            STATE_VALUE:    JSON.stringify(change.value),
            BLOCK_INDEX:    hostData['BLOCK_INDEX'],
            ACTION_INDEX:   hostData['ACTION_INDEX']
        });
    }
    for(let key of ctx.vmResult.stateDeletes){
        await this.indexerDb.createContractState({
            CONTRACT_INDEX: ctx.contractIndex,
            STATE_KEY:      key,
            STATE_VALUE:    null,
            BLOCK_INDEX:    hostData['BLOCK_INDEX'],
            ACTION_INDEX:   hostData['ACTION_INDEX']
        });
    }
}

// A guard's emissions key their execution_index to the NATIVE action's
// action_index (a guard has no action_index of its own; it rides the
// guarded SEND/ORDER/SWAP/DISPENSER). The block contract_hash preimage
// pulls emissions via INNER JOIN contract_executions ce ON
// (ce.action_index = em.execution_index). Without a parent execution
// row here, EVERY guard emission is silently dropped from contract_hash
// and two nodes that diverge on guard emissions still hash identically
// (a silent consensus fork). Write the parent row so the join resolves.
//
// A single native action can run MULTIPLE guards on the same action_index
// (a multi-leg SEND/DESTROY; or one SEND firing both the token-controller
// and the destination address-controller). They share this one execution
// row (action_index is UNIQUE: last write wins, deterministic) and their
// emissions all share execution_index. position is therefore offset by the
// count of emissions ALREADY recorded for this action so (execution_index,
// position) stays globally unique, keeping the preimage's
// ORDER BY (execution_index, position) a TOTAL order across guards (no
// engine-dependent tie-break = no fork). Offsetting the stored column means
// the existing read-side ORDER BY (here and in the sync hasher) needs no
// change. Rolled-back prior-guard emissions aren't counted, so positions
// stay gap-free and deterministic across nodes.
async function countGuardEmissionBase(ctx){
    return this.indexerDb.countContractEmissionsForExecution(
        ctx.hostData['ACTION_INDEX']);
}

// Parent execution row for this guard run (mirrors runContractExecution's
// column set). Written inside the savepoint so a failed guard emission
// rolls it back alongside its emissions: a denied guard leaves no record.
// GAS_USED/GAS_LIMIT are the guard's billed gas + its ceiling; CALLER is
// who triggered the guarded action; emitted_count accumulates across guards
// sharing this action so the surviving row reflects the action's true total.
async function writeGuardExecutionRow(ctx, basePosition){
    let hostData = ctx.hostData;
    await this.indexerDb.createContractExecution({
        ACTION_INDEX  : hostData['ACTION_INDEX'],
        CONTRACT_INDEX: ctx.contractIndex,
        CALLER        : hostData['SOURCE'],
        METHOD_NAME   : ctx.guardMethod,
        INPUT_PARAMS  : ctx.guardParams.join('|'),
        GAS_USED      : ctx.gasBilled,
        GAS_LIMIT     : ctx.guardCeiling,
        STATUS        : 'valid',
        ERROR_MESSAGE : null,
        EMITTED_COUNT : basePosition + ctx.vmResult.emittedActions.length,
        BLOCK_INDEX   : hostData['BLOCK_INDEX']
    });
}

async function applyGuardEmissions(ctx, guardCtxData, basePosition){
    let hostData = ctx.hostData;
    for(let i = 0; i < ctx.vmResult.emittedActions.length; i++){
        let emission = ctx.vmResult.emittedActions[i];
        // A guard may not emit asynchronous (ATTEST/XCALL, already blocked
        // at VM emit time) or stake-slashing (SLASH) actions. Re-check
        // host-side as defense in depth against an older bundled VM.
        if(emission.action === 'ATTEST' || emission.action === 'XCALL' || emission.action === 'SLASH')
            throw new Error('guard emission not allowed: ' + emission.action);
        // Use the host-action-global position (basePosition + i), not the
        // guard-local index: multiple guards share this action's emission space,
        // so offsetting keeps each guard's call-path subtree disjoint. A guard
        // can emit a nested EXECUTE whose callee emits ATTEST/XCALL. Without the
        // offset, two guards' first EXECUTE emissions would share call-path '0'
        // and their callees' ids could collide. Matches the stored POSITION.
        let pos = basePosition + i;
        await this.processEmission(emission, guardCtxData, pos);
        await this.indexerDb.createContractEmission({
            EXECUTION_INDEX: hostData['ACTION_INDEX'],
            EMITTED_ACTION:  emission.action,
            ACTION_INDEX:    emission.resultActionIndex || null,
            POSITION:        pos
        });
    }
}

// Guard allowed. Commit its state changes + emissions atomically; any
// failure rolls them back and DENIES. The savepoint name carries the
// (native action, controller, seq) for readability but is made unique by
// a trailing per-invocation ordinal: MariaDB silently destroys a
// duplicate-named savepoint, so two guards that share a contractIndex on
// one leg (or any future re-entrant guard path) must never derive the
// same name or an inner release would orphan the outer's rollback target.
// Returns a DENY verdict when the commit failed, null when it stuck.
async function commitGuardEffects(ctx){
    let hostData = ctx.hostData;
    let guardCtxData = buildGuardEmissionContext(ctx);

    let savepoint = await this.indexerDb.createSavepoint('controller_guard_' + parseInt(hostData['ACTION_INDEX']) + '_' + ctx.contractIndex + '_' + (parseInt(ctx.opts.seq) || 0) + '_' + (this.guardSavepointCounter++));
    try {
        await writeGuardState.call(this, ctx);
        let basePosition = await countGuardEmissionBase.call(this, ctx);
        await writeGuardExecutionRow.call(this, ctx, basePosition);
        await applyGuardEmissions.call(this, ctx, guardCtxData, basePosition);
        await this.indexerDb.releaseSavepoint(savepoint);
    } catch(emissionError){
        await this.indexerDb.rollbackToSavepoint(savepoint);
        // An infrastructure fault (VM host fault, transient DB error) is not a
        // guard decision: halt so the block rolls back and retries rather than
        // committing a validator-local DENY of a money-bearing action.
        rethrowIfInfraFault(emissionError);
        return { allow:false, reason:'controller (' + emissionError.message + ')', gasBilled: ctx.gasBilled };
    }
    return null;
}

module.exports = { commitGuardEffects };

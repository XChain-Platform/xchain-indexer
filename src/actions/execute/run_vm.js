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
 * XChain Platform Action - EXECUTE : the VM run
 *
 * The consensus-bearing middle of parse(): the read-only snapshot handed to the
 * VM, the vm.execute call itself, and the savepoint that makes the run's state
 * writes and emissions atomic. Called with the EXECUTE handler as `this` (see
 * ./index.js), so this.actions.vm, this.indexerDb and this.config are the same
 * objects the inline code read.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// Per-root discriminator for the ATTEST request_id / XCALL call_id preimages. One
// helper for all three root-bearing sites here (top-level EXECUTE, controller guard,
// emission propagation) plus deploy.js, so they cannot drift into deriving different
// ids for the same emission.
const { resolveRootDiscriminator } = require('../../consensus/batch_root_discriminator.js');

const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');

// Read-only data the gateway sees. Every member is loaded at the host block, and
// each flag-day gated member stays null below its activation so a heterogeneous
// fleet never forks on the first contract that reads it.
async function loadVmSnapshot(ctx){
    let data = ctx.data;
    let snapshot = {};

    // Load contract state from DB. BLOCK_INDEX drives the state_key collation
    // flag-day (binary-collation reload at/after activation, so case-colliding
    // keys survive; see state_key_collation_activation.js).
    snapshot.contractState = await this.indexerDb.getContractState(data['CONTRACT_ACTION_INDEX'], data['BLOCK_INDEX']);

    // Load read-only data for gateway (price data lives in local hub DB when configured)
    snapshot.oracleData = await ((this.actions && this.actions.hubDb) || this.indexerDb).getOracleDataForVM(data['BLOCK_INDEX'], data['BLOCK_TIME'], parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800);
    snapshot.crossChainData = await this.indexerDb.getCrossChainDataForVM(data['BLOCK_INDEX']);
    // Expose each poll's electorate TICK in the VM snapshot at/after the flag-day.
    let pollTickVisible = await this.actions.protocolChanges.isEnabled('VOTE_POLL_TICK_VISIBLE', data['BLOCK_INDEX']);
    snapshot.pollData    = await this.indexerDb.getPollResultsForVM(data['BLOCK_INDEX'], pollTickVisible);

    // Attestation-response snapshot backing xchain.attestation.getResponse().
    // Gated on the VM_ATTESTATION_GETRESPONSE flag-day: below activation the gateway
    // sees attestationData:null (getResponse returns null, the pre-reader behaviour),
    // so a heterogeneous fleet never forks on the first getResponse-reading contract.
    // Scoped to THIS contract's fulfilled requests (see getAttestationDataForVM).
    snapshot.attestationData = null;
    if(await this.actions.protocolChanges.isEnabled('VM_ATTESTATION_GETRESPONSE', data['BLOCK_INDEX']))
        snapshot.attestationData = await this.indexerDb.getAttestationDataForVM(data['CONTRACT_ACTION_INDEX'], data['BLOCK_INDEX']);

    // Pre-load contract-stake snapshot scoped to THIS contract. Backs the
    // xchain.contract.{getStake,getTotalStaked,getStakers,slash} APIs synchronously.
    // Implicit slash authorization: the accessor only knows this contract's stakes.
    snapshot.contractStakeData = await this.indexerDb.getContractStakeDataForVM(
        data['CONTRACT_ACTION_INDEX'], data['BLOCK_INDEX']
    );

    // Balance + token-info snapshot backing xchain.getBalance / getTokenInfo.
    // Scoped to SOURCE + this contract's derived address (pre-action state);
    // a contract verifies its own holdings (e.g. a just-DEPOSITed amount in a
    // BATCH) by reading getBalance(getContractAddress(), tick).
    // Gated on the VM_BALANCE_TOKENINFO flag-day: below activation the gateway
    // sees balances:null / tokenInfo:null (original <=2.7.10 behaviour), so a
    // heterogeneous fleet never forks on the first balance-reading contract.
    let contractAddr = 'C:' + this.config['CHAIN'] + ':' + data['CONTRACT_ACTION_INDEX'];
    snapshot.vmLedger = { balances: null, tokenInfo: null };
    if(await this.actions.protocolChanges.isEnabled('VM_BALANCE_TOKENINFO', data['BLOCK_INDEX'])){
        snapshot.vmLedger = await this.indexerDb.buildVmBalancesAndTokenInfo(
            [data['SOURCE'], contractAddr], data['BLOCK_INDEX'], data['ACTION_INDEX']
        );
    }
    return snapshot;
}

// The vm.execute options object. Split out so the option list, which is the
// consensus-visible interface to the VM, reads as one block.
function buildVmOptions(ctx, snapshot, blockHash, rootDiscrim){
    let data = ctx.data;
    return {
        code:             ctx.contractInfo.code,
        state:            snapshot.contractState,
        method:           data['METHOD'],
        params:           data['METHOD_PARAMS'] ? data['METHOD_PARAMS'].split('|') : [],
        caller:           data['SOURCE'],
        contractAddress:  'C:' + this.config['CHAIN'] + ':' + data['CONTRACT_ACTION_INDEX'],
        contractIndex:    data['CONTRACT_ACTION_INDEX'],
        txHash:           data['TX_HASH'],   // needed for deterministic attestation request_id
        blockContext: {
            height:    data['BLOCK_INDEX'],
            timestamp: data['BLOCK_TIME'],
            hash:      blockHash
        },
        // Cross-contract call threading: the callee's ceiling is its
        // caller-funded reservation; depth gates emit.execute recursion;
        // callPath anchors the attestation request_id + cross-chain call_id
        // preimages so two nested runs of the same contract in one tx cannot
        // collide, and unlike action_index it is content-derived so it
        // stays byte-stable across nodes/reorgs. Root on-chain EXECUTE = ''.
        gasCeiling:        ctx.execCeiling,
        callDepth:         Number(data['CALL_DEPTH']) || 0,
        actionIndex:       data['ACTION_INDEX'],
        callPath:          data['CALL_PATH'] || '',
        // Per-root discriminator for the request_id/call_id preimages. The value is
        // TX_VOUT: the on-chain output index of the ROOT that seeded this subtree.
        // NOTE: the VM opt key is named `rootActionIndex` and the data key is
        // ROOT_ACTION_INDEX for historical reasons, but the value is always the
        // output index (TX_VOUT), NOT the action_index. Do not "correct" one side
        // to the true action_index without updating the full preimage on both sides;
        // that would silently fork the hash. A top-level on-chain EXECUTE has no
        // inherited ROOT_ACTION_INDEX so it IS the root and uses its own TX_VOUT; a
        // nested EXECUTE emission inherits the root's value via processEmission.
        // TX_VOUT is stable across reorgs and distinct per action within a tx EXCEPT
        // inside a BATCH, whose subcommands are all root actions under the ONE TX_VOUT
        // actions/index.js assigns per transaction; there the subcommand's BATCH_POSITION is
        // appended ("<TX_VOUT>.<position>", flag-day gated) so two same-contract EXECUTE
        // subcommands cannot derive one request_id (src/consensus/batch_root_discriminator.js).
        rootActionIndex:   rootDiscrim,
        // Cross-chain call context: hop budget for emit.crossExecute (threaded
        // from XEXEC injections / result callbacks), the network bound into the
        // call_id preimage, and the cross-call flag the harness uses to enforce
        // the target's crossCallable allowlist.
        crossHops:         Number(data['CROSS_HOPS']) || 0,
        isCrossCall:       Boolean(data['IS_CROSS_CALL']),
        network:           this.config['NETWORK'],
        balances:          snapshot.vmLedger.balances,
        tokenInfo:         snapshot.vmLedger.tokenInfo,
        oracleData:        snapshot.oracleData,
        crossChainData:    snapshot.crossChainData,
        pollData:          snapshot.pollData,
        attestationData:   snapshot.attestationData, // null pre-flag; populated at/after VM_ATTESTATION_GETRESPONSE
        contractStakeData: snapshot.contractStakeData,
        providerDeadlines: this.providerDeadlineWindows
    };
}

async function executeContractVm(ctx, snapshot){
    let data = ctx.data;

    // Derive deterministic block hash from block_index + block_time
    let blockHash = crypto.createHash('sha256')
        .update(String(data['BLOCK_INDEX']) + ':' + String(data['BLOCK_TIME']))
        .digest('hex');

    // Per-root discriminator for the request_id/call_id preimages: the root's
    // TX_VOUT, plus this subcommand's position when the root is one of a BATCH's
    // (flag-day gated). See src/consensus/batch_root_discriminator.js.
    let rootDiscrim = (data['ROOT_ACTION_INDEX'] != null) ? data['ROOT_ACTION_INDEX']
        : await resolveRootDiscriminator(this.actions.protocolChanges, data['BLOCK_INDEX'], data['TX_VOUT'], data['BATCH_POSITION']);

    // Execute contract in VM
    return this.actions.vm.execute(buildVmOptions.call(this, ctx, snapshot, blockHash, rootDiscrim));
}

// State writes for a successful run, applied inside the savepoint below.
async function writeVmStateChanges(ctx, vmResult){
    let data = ctx.data;
    // Write state changes
    for(let change of vmResult.stateChanges){
        await this.indexerDb.createContractState({
            CONTRACT_INDEX: data['CONTRACT_ACTION_INDEX'],
            STATE_KEY:      change.key,
            STATE_VALUE:    JSON.stringify(change.value),
            BLOCK_INDEX:    data['BLOCK_INDEX'],
            ACTION_INDEX:   data['ACTION_INDEX']
        });
    }
    // Write state deletes (null value = deleted)
    for(let key of vmResult.stateDeletes){
        await this.indexerDb.createContractState({
            CONTRACT_INDEX: data['CONTRACT_ACTION_INDEX'],
            STATE_KEY:      key,
            STATE_VALUE:    null,
            BLOCK_INDEX:    data['BLOCK_INDEX'],
            ACTION_INDEX:   data['ACTION_INDEX']
        });
    }
}

async function applyVmEmissions(ctx, vmResult, slashLedger){
    let data = ctx.data;
    // Process emitted actions through existing handlers
    for(let i = 0; i < vmResult.emittedActions.length; i++){
        let emission = vmResult.emittedActions[i];

        // SLASH emissions are internal: never on-wire, never run through
        // the generic emission router (no decoder/parser exists for them).
        // Handled inline: deduct stake, credit destination, write event log.
        if(emission.action === 'SLASH'){
            await this.processSlashEmission(emission, data, i, slashLedger);
        } else {
            await this.processEmission(emission, data, i);
            // Cross-contract callee finished: bank its unused
            // reservation (gasLimit - billed, including its own
            // subtree's refunds) for this run's fee settlement.
            if(emission.action === 'EXECUTE')
                ctx.nestedGasUnused += Number(emission.gasUnusedSubtree) || 0;
        }

        // Record emission link (SLASH rows carry no resultActionIndex)
        await this.indexerDb.createContractEmission({
            EXECUTION_INDEX: data['ACTION_INDEX'],
            EMITTED_ACTION:  emission.action,
            ACTION_INDEX:    emission.resultActionIndex || null,
            POSITION:        i
        });
    }
}

// Process state changes + emissions atomically via DB savepoint.
// Name is unique per execution: savepoints NEST when an emitted EXECUTE
// runs a callee inside this one, and MariaDB re-uses a duplicate
// savepoint name by DESTROYING the earlier one. A fixed 'vm_execute'
// name would silently invalidate the outer rollback scope.
async function commitVmEffects(ctx, vmResult){
    let data = ctx.data;
    let savepoint = await this.indexerDb.createSavepoint('vm_execute_' + parseInt(data['ACTION_INDEX']));
    try {
        await writeVmStateChanges.call(this, ctx, vmResult);
        // Running slash ledger totals for THIS execution, keyed by (tick, address).
        // Every slash in this frame writes its credit and escrow rows under the same
        // action_index, and createLedgerChangeRecord overwrites a same-key row rather
        // than accumulating, so a second same-token slash would erase the first
        // (slash_ledger_consolidation_activation.js). Owned by the frame that owns the
        // action_index: a nested EXECUTE builds its own and never merges into this one,
        // and a savepoint rollback abandons it with the frame.
        let slashLedger = { credits: new Map(), escrows: new Map() };
        await applyVmEmissions.call(this, ctx, vmResult, slashLedger);

        await this.indexerDb.releaseSavepoint(savepoint);
    } catch(emissionError){
        // Roll back ALL state changes and emissions from this execution
        await this.indexerDb.rollbackToSavepoint(savepoint);
        // An infrastructure fault (VM host fault, transient DB error) is not a
        // contract outcome: halt so the block rolls back and retries rather than
        // committing a validator-local 'failed' status that would fork the chain.
        rethrowIfInfraFault(emissionError);
        ctx.vmError = 'emission failed: ' + emissionError.message;
        ctx.emittedCount = 0;
        // No refunds on a failed tree: the caller pays its full metered
        // gas (reservations included), mirroring the existing
        // caller-pays-for-failed-attempt rule.
        ctx.nestedGasUnused = 0;
    }
}

/*****************************************************************
 * VM Execution
 ****************************************************************/

async function runVmExecution(ctx, limits){
    let data = ctx.data;

    ctx.gasUsed = ctx.gasCost;
    ctx.emittedCount = 0;
    ctx.vmError = null;
    ctx.vmReturnValue = null;

    // Per-call gas ceiling. A cross-contract callee (reached via emit.execute)
    // runs against its caller-funded reservation (VM_GAS_LIMIT, validated in
    // processEmission); top-level EXECUTEs and system-injected callbacks (which
    // carry IS_EMISSION but no VM_GAS_LIMIT) use the protocol ceiling.
    ctx.execCeiling = (data['IS_EMISSION'] && Number.isInteger(data['VM_GAS_LIMIT']))
        ? data['VM_GAS_LIMIT'] : limits.GAS_CEILING;

    // Unused cross-contract gas reservations accumulated from this run's
    // emitted EXECUTEs (each callee's gasLimit minus what it was billed).
    // Refunded at the fee settlement below; zeroed if the emission savepoint
    // rolls back (no refunds on a failed tree).
    ctx.nestedGasUnused = 0;

    // Fail CLOSED when the VM executor is unavailable, exactly as DEPLOY
    // (deploy.js: EXECUTOR_UNAVAILABLE) and the controller guard below
    // (runControllerGuard throws the same code) already do. Without this, a node whose
    // optional require('xchain-vm') failed (actions.js sets this.vm=null and
    // only warns) would SKIP the whole VM block below and record this EXECUTE
    // 'valid' with base gas, no state changes and no emissions, while the rest
    // of the fleet applies real ones: a host-condition-induced ledger fork.
    // Throwing EXECUTOR_UNAVAILABLE writes NO verdict at all - faultGuard and
    // XChainIndexer.js treat the code as an infra halt, so the block rolls back
    // and retries without committing until the native VM is rebuilt. Placed at
    // the VM block rather than earlier so an EXECUTE already rejected by a
    // VM-independent rule still records the same verdict as a healthy node.
    // No consensus rule changes, so no flag-day is needed.
    if(!ctx.error && ctx.contractInfo && !this.actions.vm){
        let e = new Error('execute VM executor unavailable');
        e.code = 'EXECUTOR_UNAVAILABLE';
        throw e;
    }

    if(!ctx.error && this.actions.vm && ctx.contractInfo){
        let snapshot = await loadVmSnapshot.call(this, ctx);
        let vmResult = await executeContractVm.call(this, ctx, snapshot);

        ctx.gasUsed = vmResult.gasUsed;
        ctx.emittedCount = vmResult.emittedActions.length;
        ctx.vmReturnValue = vmResult.success ? vmResult.returnValue : null;

        if(!vmResult.success)
            ctx.vmError = vmResult.error;

        if(vmResult.success)
            await commitVmEffects.call(this, ctx, vmResult);
    }
}

module.exports = { runVmExecution };

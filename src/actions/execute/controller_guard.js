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
 * XChain Platform Action - EXECUTE : controller-bound token guard
 *
 * The guard run itself. Its contract (what the caller passes and what the
 * verdict means) is documented at Execute.runControllerGuard in ./index.js,
 * which is the method every caller reaches; this module is the body.
 *
 * Every phase below is called with the EXECUTE handler as `this`, and threads
 * one `ctx` holding what the phases before it decided: the guarded action's
 * opts and host data, the controller contract, its ceiling, the root
 * discriminator the VM and the emission context must share, and the run.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// Per-root discriminator for the ATTEST request_id / XCALL call_id preimages. One
// helper for all three root-bearing sites here (top-level EXECUTE, controller guard,
// emission propagation) plus deploy.js, so they cannot drift into deriving different
// ids for the same emission.
const { resolveRootDiscriminator } = require('../../consensus/batch_root_discriminator.js');

const { commitGuardEffects } = require('./guard_effects.js');

// Reserved method name a controller-bound token's contract must export. The
// indexer invokes it before a guarded native action (SEND/ORDER/SWAP/DISPENSER)
// on the token settles; the contract returns normally to ALLOW or reverts to
// DENY. Canonical: xchain-documentation/protocol/controller-bound-tokens.md.
const GUARD_METHOD = 'guard';

// Returns a DENY verdict when the controller cannot run, null when it can.
async function loadGuardContract(ctx){
    // Load + verify the controller contract is active. Fail-closed.
    ctx.contractInfo = await this.indexerDb.getContract(ctx.contractIndex);
    if(!ctx.contractInfo)
        return { allow:false, reason:'controller (unknown)', gasBilled:0 };
    let contractStatus = await this.indexerDb.getStatusString(ctx.contractInfo.status_id);
    if(contractStatus !== 'valid')
        return { allow:false, reason:'controller (not active)', gasBilled:0 };
    // A missing VM is a HOST condition, not a contract outcome, so it must HALT
    // rather than deny. The denies above derive from consensus state every node
    // reads identically; this one derives from whether THIS node's optional
    // require('xchain-vm') happened to load (actions.js sets this.vm=null and only
    // warns). Denying on it commits a validator-local verdict into the ledger and
    // the block hash while a healthy peer runs the guard and allows the action: a
    // host-condition-induced fork. Throw the same EXECUTOR_UNAVAILABLE host fault
    // DEPLOY throws and the vm.execute catch below rethrows, so faultGuard and the
    // block loop roll the block back and retry, writing no verdict at all. No
    // consensus rule changes, so no flag-day is needed.
    if(!this.actions.vm){
        let e = new Error('controller guard VM executor unavailable');
        e.code = 'EXECUTOR_UNAVAILABLE';
        throw e;
    }
    return null;
}

// Load contract state + read-only data (mirrors parse(), including the
// state_key collation flag-day keyed on the host block).
async function loadGuardSnapshot(ctx){
    let hostData = ctx.hostData;
    let snapshot = {};
    snapshot.contractState = await this.indexerDb.getContractState(ctx.contractIndex, hostData['BLOCK_INDEX']);
    snapshot.oracleData = await ((this.actions && this.actions.hubDb) || this.indexerDb).getOracleDataForVM(hostData['BLOCK_INDEX'], hostData['BLOCK_TIME'], parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800);
    snapshot.crossChainData = await this.indexerDb.getCrossChainDataForVM(hostData['BLOCK_INDEX']);
    // Expose each poll's electorate TICK in the VM snapshot at/after the flag-day.
    let pollTickVisible = await this.actions.protocolChanges.isEnabled('VOTE_POLL_TICK_VISIBLE', hostData['BLOCK_INDEX']);
    snapshot.pollData       = await this.indexerDb.getPollResultsForVM(hostData['BLOCK_INDEX'], pollTickVisible);
    snapshot.contractStakeData = await this.indexerDb.getContractStakeDataForVM(ctx.contractIndex, hostData['BLOCK_INDEX']);
    // Gated on the VM_BALANCE_TOKENINFO flag-day (see primary EXECUTE path).
    snapshot.guardLedger = { balances: null, tokenInfo: null };
    if(await this.actions.protocolChanges.isEnabled('VM_BALANCE_TOKENINFO', hostData['BLOCK_INDEX'])){
        snapshot.guardLedger = await this.indexerDb.buildVmBalancesAndTokenInfo(
            [hostData['SOURCE'], ctx.derived], hostData['BLOCK_INDEX'], hostData['ACTION_INDEX']
        );
    }
    snapshot.blockHash = crypto.createHash('sha256')
        .update(String(hostData['BLOCK_INDEX']) + ':' + String(hostData['BLOCK_TIME']))
        .digest('hex');
    return snapshot;
}

// Positional, all-string guard inputs. Order is consensus; see spec.
function buildGuardParams(opts){
    return [
        String(opts.actionType),
        String(this.util.isNull(opts.from)         ? '' : opts.from),
        String(this.util.isNull(opts.to)           ? '' : opts.to),
        String(this.util.isNull(opts.tick)         ? '' : opts.tick),
        String(this.util.isNull(opts.amount)       ? '' : opts.amount),
        String(this.util.isNull(opts.price)        ? '' : opts.price),
        String(this.util.isNull(opts.proceedsTick) ? '' : opts.proceedsTick)
    ];
}

async function runGuardVm(ctx, snapshot){
    let hostData = ctx.hostData;
    try {
        return await this.actions.vm.execute({
            code:            ctx.contractInfo.code,
            state:           snapshot.contractState,
            method:          GUARD_METHOD,
            params:          ctx.guardParams,
            caller:          hostData['SOURCE'],   // who triggered the guarded action
            contractAddress: ctx.derived,
            contractIndex:   ctx.contractIndex,
            txHash:          hostData['TX_HASH'],
            blockContext: {
                height:    hostData['BLOCK_INDEX'],
                timestamp: hostData['BLOCK_TIME'],
                hash:      snapshot.blockHash
            },
            gasCeiling:        ctx.guardCeiling,
            callDepth:         ctx.callDepth,
            actionIndex:       hostData['ACTION_INDEX'],
            callPath:          '',     // a guard is a root execution for its own subtree
            // Root discriminator = the guarded native action's on-chain output index (TX_VOUT),
            // carried under the VM opt name `rootActionIndex` the gateway preimage reads.
            // Distinguishes this guard subtree from a co-tx top-level EXECUTE that also seeds ''.
            // A guarded action inside a BATCH shares its TX_VOUT with every sibling subcommand,
            // so the subcommand position is appended there (flag-day gated); without it two
            // guarded sends of one controlled token in a BATCH seed identical subtrees.
            rootActionIndex:   ctx.guardRootDiscrim,
            isGuard:           true,   // disables ATTEST/XCALL in the gateway
            network:           this.config['NETWORK'],
            balances:          snapshot.guardLedger.balances,
            tokenInfo:         snapshot.guardLedger.tokenInfo,
            oracleData:        snapshot.oracleData,
            crossChainData:    snapshot.crossChainData,
            pollData:          snapshot.pollData,
            // A controller guard is a lightweight allow/deny + royalty decision on a
            // native action; it has no attestation-request surface (the gateway also
            // disables attestation.request under isGuard), so it never reads responses.
            // Keep attestationData:null here to avoid widening the guard's consensus
            // read surface.
            attestationData:   null,
            contractStakeData: snapshot.contractStakeData,
            providerDeadlines: this.providerDeadlineWindows
        });
    } catch(e){
        // A host fault (e.g. permanently broken subprocess executor) must HALT,
        // not silently deny. Rethrow so the block processor stops rather than
        // committing a fabricated decision that could fork the chain.
        throw e;
    }
}

// Parse the guard's return value for an optional royalty/fee split. A controlled-token SALE
// guard (ORDER/SWAP create) may return { payoutLegs: [{to, bps}] } with basis-point cuts of
// the seller's proceeds applied at match (Utility.applyProceedsSplit). Validate fail-closed
// BEFORE committing emissions: a malformed leg or a total over CONTROLLER_MAX_TAKE_BPS DENIES
// the action (no savepoint exists yet, so nothing to roll back).
// Returns { deny } or { payoutLegs }.
async function parseGuardPayoutLegs(ctx){
    let gasBilled = ctx.gasBilled;
    let payoutLegs = null;
    // vm.execute() returns returnValue as a JSON-serialized STRING (the contract wrapper
    // JSON-stringifies the contract's return inside the isolate), so parse before the object
    // check below. A raw `typeof ret === 'object'` never matches and silently drops the legs.
    let ret = ctx.vmResult.returnValue;
    if(ret && typeof ret === 'string'){ try { ret = JSON.parse(ret); } catch(e){ ret = null; } }
    if(ret && typeof ret === 'object' && Array.isArray(ret.payoutLegs) && ret.payoutLegs.length > 0){
        let parsed = [];
        let totalBps = 0;
        for(let leg of ret.payoutLegs){
            let bps = (leg && this.util.isNumeric(leg.bps)) ? parseInt(leg.bps) : NaN;
            if(!Number.isInteger(bps) || bps < 0 || this.util.isNull(leg.to) || !this.util.isCryptoAddress(String(leg.to)))
                return { deny: { allow:false, reason:'controller (bad payout leg)', gasBilled } };
            totalBps += bps;
            parsed.push({ to: String(leg.to), bps: bps });
        }
        let cap = parseInt(this.config['CONTROLLER_MAX_TAKE_BPS']);
        if(!Number.isInteger(cap) || cap > 10000) cap = 10000;
        // Phase E: a contract may declare a TIGHTER per-contract royalty cap (maxTakeBps)
        // in its deploy manifest. The effective cap is min(global, per-contract). Loaded
        // lazily here: only guards that actually return payout legs pay the lookup.
        let controllerManifest = await this.indexerDb.getContractPermissions(ctx.contractIndex);
        if(controllerManifest && Number.isInteger(controllerManifest.maxTakeBps) &&
           controllerManifest.maxTakeBps >= 0 && controllerManifest.maxTakeBps < cap)
            cap = controllerManifest.maxTakeBps;
        if(totalBps > cap)
            return { deny: { allow:false, reason:'controller (payout exceeds cap)', gasBilled } };
        payoutLegs = parsed;
    }
    return { payoutLegs };
}

async function runControllerGuard(opts, limits){
    let chain         = this.config['CHAIN'];
    let contractIndex = parseInt(opts.controllerIndex);
    let hostData      = opts.hostData;
    let callDepth     = Number(opts.callDepth) || 0;
    let derived       = 'C:' + chain + ':' + contractIndex;

    // Depth cap (defense in depth; the emit path checks too). A guard whose
    // emit.send moves another controlled token recurses through this method.
    if(callDepth > limits.MAX_CALL_DEPTH)
        return { allow:false, reason:'controller (max call depth)', gasBilled:0 };

    let ctx = { opts, hostData, contractIndex, derived, callDepth, guardMethod: GUARD_METHOD };

    let unavailable = await loadGuardContract.call(this, ctx);
    if(unavailable) return unavailable;

    // Guard gas ceiling (consensus param, per-chain GAS_SCHEDULE). Validated canonical
    // key resolved once via the shared resolver (throws on missing/mistyped; no silent
    // hard-coded fallback that could fork a misconfigured node).
    ctx.guardCeiling = this.util.resolveGuardGasCeiling(this.config);

    let snapshot = await loadGuardSnapshot.call(this, ctx);

    // Per-root discriminator for this guard subtree (see src/consensus/batch_root_discriminator.js).
    // Resolved ONCE and used by both the guard's vm.execute and its emission context,
    // which must hand the VM and the host re-derivation the identical value.
    ctx.guardRootDiscrim = await resolveRootDiscriminator(this.actions.protocolChanges, hostData['BLOCK_INDEX'], hostData['TX_VOUT'], hostData['BATCH_POSITION']);

    ctx.guardParams = buildGuardParams.call(this, opts);
    ctx.vmResult = await runGuardVm.call(this, ctx, snapshot);

    // The VM already clamps a resource-termination gasUsed to the ceiling;
    // clamp again defensively so the fee can never exceed the reservation.
    ctx.gasBilled = Math.min(Number(ctx.vmResult.gasUsed) || 0, ctx.guardCeiling);

    // Guard reverted / out-of-gas / runtime error -> DENY (fail-closed). The
    // SOURCE is still billed gasBilled (caller-pays-for-attempt) only when the
    // action proceeds; a denied action records no ledger change (see caller).
    if(!ctx.vmResult.success)
        return { allow:false, reason:'controller (' + this.util.vmFailureStatus(ctx.vmResult.error) + ')', gasBilled: ctx.gasBilled };

    let legs = await parseGuardPayoutLegs.call(this, ctx);
    if(legs.deny) return legs.deny;

    let denied = await commitGuardEffects.call(this, ctx);
    if(denied) return denied;

    return { allow:true, reason:null, gasBilled: ctx.gasBilled, payoutLegs: legs.payoutLegs };
}

module.exports = { runControllerGuard };

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
 * XChain Platform Action - EXECUTE : emission processing
 *
 * Routes an action a contract emitted through the same handler a wallet-
 * broadcast one would reach, after re-validating host-side everything the VM
 * was supposed to have enforced. Called with the EXECUTE handler as `this`
 * (see ./index.js), which is also what keeps this.truncateEmissionAmounts,
 * this.buildActionParams and this.getActionHandler the handler's own methods.
 *
 ********************************************************************/

'use strict';

// Per-root discriminator for the ATTEST request_id / XCALL call_id preimages. One
// helper for all three root-bearing sites here (top-level EXECUTE, controller guard,
// emission propagation) plus deploy.js, so they cannot drift into deriving different
// ids for the same emission.
const { resolveRootDiscriminator } = require('../../consensus/batch_root_discriminator.js');

// Amount-bearing fields of every emittable action, mapping each amount param to the param
// that names the tick it is denominated in. processEmission normalizes each to
// that tick's decimals before dispatch, so a contract that computes an over-precise amount
// (e.g. an AMM's 64-digit bignum payout) emits a tick-precise amount that passes
// isValidAmountFormat and matches what the ledger stores. ISSUE declares the new tick's
// decimals inline (`declared`) because the tick is not in the issues table yet. Emittable
// actions with no tick-denominated amount are absent (CALLBACK/XCALL/EXECUTE/BROADCAST/
// COINPAY/FILE/LINK/LIST/MESSAGE/SWEEP); COINPAY's amount is a native-coin value, not a tick.
// SLASH is handled inline, not here. KEEP IN SYNC with buildActionParams: the emission-map
// coverage test (test/unit/contracts/execute_emission_truncation.test.js) fails if a new amount-bearing
// emittable action is missing here.
const EMISSION_AMOUNT_FIELDS = {
    SEND:      [{ amount: 'quantity',   tick: 'tick' }],
    MINT:      [{ amount: 'quantity',   tick: 'tick' }],
    DESTROY:   [{ amount: 'quantity',   tick: 'tick' }],
    AIRDROP:   [{ amount: 'quantity',   tick: 'tick' }],
    DIVIDEND:  [{ amount: 'quantity',   tick: 'dividendTick' }],
    ORDER:     [{ amount: 'giveAmount', tick: 'giveTick' }, { amount: 'getAmount', tick: 'getTick' }],
    DISPENSER: [{ amount: 'giveAmount', tick: 'giveTick' }, { amount: 'giveEscrow', tick: 'giveTick' }, { amount: 'getAmount', tick: 'getTick' }],
    ATTEST:    [{ amount: 'feeAmount',  tick: 'feeTick' }],
    ISSUE:     [{ amount: 'maxSupply',  declared: true }, { amount: 'maxMint', declared: true }, { amount: 'mintSupply', declared: true }, { amount: 'callbackAmount', tick: 'callbackTick' }],
    // VOTE v0's DEPOSIT and GAS_ESCROW are denominated in the fixed GAS tick
    // (config GAS), not a tick named by a param; `gas: true` resolves it.
    // VOTE v1 (ballot) has neither param, so both fields skip as empty.
    VOTE:      [{ amount: 'deposit',    gas: true }, { amount: 'gasEscrow', gas: true }],
};

// Permissions manifest (Phase E): the SINGLE choke point for every emission path.
// Constructor (deploy.js), EXECUTE, and a controller guard all funnel through here. If
// the EMITTING contract declared a `permissions` allowlist at deploy time, every action
// it emits must be a member; a non-member throws, which rolls back the emitter's
// savepoint and fails the host action (deploy reject / EXECUTE revert / guard DENY).
// Fail-closed by construction. A contract with no manifest row (null) or a row that
// declared only maxTakeBps (permissions null) is unrestricted (the backward-compatible
// default). An explicit empty allowlist (`[]`) permits no emissions. The manifest is
// immutable (contract code is immutable), read by indexed lookup on contract_index.
async function assertEmissionPermitted(executionData, action){
    let emitterIndex = executionData['CONTRACT_ACTION_INDEX'];
    if(emitterIndex !== undefined && emitterIndex !== null){
        let manifest = await this.indexerDb.getContractPermissions(emitterIndex);
        if(manifest && Array.isArray(manifest.permissions) && manifest.permissions.indexOf(action) === -1)
            throw new Error('manifest: action ' + action + ' not permitted');
    }
}

function assertEmitterPosition(action, position){
    // ATTEST v0 (request) anchors its on-chain request_id to the emitter position, so the
    // handler can re-derive and verify it (defends against a compromised VM forging a
    // request_id). EMITTER_POSITION is therefore mandatory for ATTEST emissions: fail
    // loudly at the source if a caller ever omits it rather than letting the handler fall
    // back to accepting an unverified request_id.
    if(action === 'ATTEST' && (position === undefined || position === null))
        throw new Error('ATTEST emission missing EMITTER_POSITION (position argument)');

    // XCALL anchors its call_id to the emitter position the same way; mandatory.
    if(action === 'XCALL' && (position === undefined || position === null))
        throw new Error('XCALL emission missing EMITTER_POSITION (position argument)');
}

// Host-side re-validation of the call bounds the VM enforces at emit time, plus the
// depth/hop/gas context the callee's own parse runs against.
function validateEmissionBounds(action, params, executionData, limits){
    // Cross-contract call emissions: re-validate depth + gasLimit HOST-side
    // (defense in depth; the VM enforces both at emit time, but an older or
    // compromised bundled VM must not be able to bypass them), then thread
    // the callee's depth + caller-funded ceiling through the emission data.
    let callDepth = (Number(executionData['CALL_DEPTH']) || 0) + 1;
    let crossHops = Number(executionData['CROSS_HOPS']) || 0;
    let nestedGasLimit = null;
    if(action === 'EXECUTE'){
        if(callDepth > limits.MAX_CALL_DEPTH)
            throw new Error('EXECUTE emission exceeds max call depth (' + limits.MAX_CALL_DEPTH + ')');
        nestedGasLimit = Number(params.gasLimit);
        if(!Number.isInteger(nestedGasLimit) || nestedGasLimit < limits.MIN_CALL_GAS || nestedGasLimit > limits.GAS_CEILING)
            throw new Error('EXECUTE emission gasLimit out of range [' + limits.MIN_CALL_GAS + ', ' + limits.GAS_CEILING + ']');
    }

    // Cross-chain call emissions: the hop count is HOST-derived (context + 1),
    // never trusted from the VM, and capped so two contracts cannot ping-pong
    // X->Y->X forever (the injected execution on the far chain is fee-less there,
    // so economics alone cannot bound the loop). gasLimit is re-validated against
    // the XCALL caps (tighter than same-chain).
    if(action === 'XCALL'){
        // Disallowed from DEPLOY constructors in v1: a constructor has no
        // settled execution context for the deadline/callback lifecycle.
        if(executionData['IS_CONSTRUCTOR'])
            throw new Error('XCALL emission is not allowed from a constructor');
        let hostHops = crossHops + 1;
        if(hostHops > limits.XCALL_MAX_HOPS)
            throw new Error('XCALL emission exceeds max cross-chain hops (' + limits.XCALL_MAX_HOPS + ')');
        params.crossHops = hostHops;
        let xcallGas = Number(params.gasLimit);
        if(!Number.isInteger(xcallGas) || xcallGas < limits.XCALL_MIN_GAS || xcallGas > limits.XCALL_MAX_GAS)
            throw new Error('XCALL emission gasLimit out of range [' + limits.XCALL_MIN_GAS + ', ' + limits.XCALL_MAX_GAS + ']');
    }
    return { callDepth, crossHops, nestedGasLimit };
}

async function deriveEmissionRouting(executionData, position){
    // Deterministic call-path for the request_id / call_id preimages.
    //   emitterPath = the path of the EMITTING execution (root on-chain action = '').
    //   childPath   = emitterPath extended by this emission's position (the path of
    //                 the execution a nested EXECUTE emission will itself run as).
    // Encoding: '>'-joined non-negative integer positions; '>' appears in no adjacent
    // preimage field, so the path is one injection-free token. MUST byte-match the VM
    // (xchain-vm gateway.js attestation.request + gateway-emit.js crossExecute, which
    // hash the running execution's callPath). EMITTER_PATH replaces the old
    // EMITTER_ACTION_INDEX (which tracked injection timing -> forked the PBFT on reorg).
    let emitterPath = executionData['CALL_PATH'] || '';
    let childPath   = (emitterPath === '') ? String(position) : emitterPath + '>' + String(position);

    // Per-root discriminator (request_id/call_id preimage). UNLIKE childPath it is pinned at
    // the root and propagated UNCHANGED: a top-level EXECUTE's executionData carries no
    // ROOT_ACTION_INDEX, so its own TX_VOUT (a pure on-chain output index, stable across reorgs)
    // IS the root; a nested/guard executionData already carries the inherited root value. Stamped
    // onto emissionData so attest.js/xcall.js re-derive with it and nested EXECUTEs inherit it.
    // Inside a BATCH every subcommand is a root under the ONE TX_VOUT of the transaction, so
    // the subcommand's BATCH_POSITION is appended (flag-day gated); this MUST reproduce the
    // value the executing vm.execute was handed, or the host re-derives a request_id the VM
    // never hashed (src/consensus/batch_root_discriminator.js).
    let rootActionIndex = (executionData['ROOT_ACTION_INDEX'] != null) ? executionData['ROOT_ACTION_INDEX']
                            : await resolveRootDiscriminator(this.actions.protocolChanges, executionData['BLOCK_INDEX'],
                                                             executionData['TX_VOUT'], executionData['BATCH_POSITION']);
    return { emitterPath, childPath, rootActionIndex };
}

// The emitted action as the handler will see it: the contract's address as SOURCE,
// tick-precise amounts, positional params and the FORMAT the handler dispatches on.
async function prepareEmissionParams(action, params, executionData){
    // Force source to the contract's derived address
    let contractAddress = 'C:' + this.config['CHAIN'] + ':' + executionData['CONTRACT_ACTION_INDEX'];

    // Normalize emitted amounts to their tick's decimals BEFORE building params and
    // dispatching. Contracts compute with 64-digit bignum precision, so an
    // emitted amount can carry more fractional digits than the tick; left unnormalized it
    // would be rejected by isValidAmountFormat (reverting e.g. every AMM swap) or stored
    // unrounded while the ledger rounds it (supply desync). This applies the SAME
    // normalization the ledger uses, so the two agree.
    await this.truncateEmissionAmounts(action, params);

    // Build positional params array for the handler
    let actionParams = this.buildActionParams(action, params);

    // Most emittable actions are version-0 only, but VOTE is sub-typed by version
    // (0 = create poll, 1 = cast ballot) and its handler dispatches on FORMAT. Carry
    // the emitted version into FORMAT so a contract-cast ballot isn't mis-parsed as a
    // poll creation (which then fails the create-only "must hold TICK" gate).
    // Only v0/v1 are emittable: v2 (finalize) is system-injected-only and v3
    // (delegate) has no emission param mapping, so buildActionParams would hand
    // parseDelegate a mis-mapped v0 layout. The VM gateway already rejects both
    // at emit time; re-check host-side as defense in depth against an older
    // bundled VM, matching the guard-emission checks above.
    if(action === 'VOTE' && Number(params.version) > 1)
        throw new Error('emitted VOTE version ' + params.version + ' is not emittable (only v0 create / v1 ballot)');
    let emissionFormat = (action === 'VOTE') ? (Number(params.version) || 0) : 0;

    return { contractAddress, actionParams, emissionFormat };
}

async function createEmissionActionIndex(action, executionData, prepared){
    // Create a real action_index for this emission
    return this.indexerDb.createActionIndex({
        ACTION:      action,
        BLOCK_INDEX: executionData['BLOCK_INDEX'],
        TX_INDEX:    executionData['TX_INDEX'],
        TX_VOUT:     executionData['TX_VOUT'],
        FORMAT:      prepared.emissionFormat,
        // The emission's TRUE source is the contract, not the EXECUTE caller. Persisting it
        // here is what lets refunds/ownership/auth resolve back to the contract later.
        SOURCE:      prepared.contractAddress
    }, true);  // force=true to always create new
}

// Build the data object that action handlers expect
function buildEmissionData(executionData, position, prepared, bounds, routing, emissionActionIndex){
    return {
        ACTION_INDEX:       emissionActionIndex,
        SOURCE:             prepared.contractAddress,
        FEE_PAYER:          executionData['SOURCE'],
        BLOCK_INDEX:        executionData['BLOCK_INDEX'],
        BLOCK_TIME:         executionData['BLOCK_TIME'],
        TX_INDEX:           executionData['TX_INDEX'],
        TX_HASH:            executionData['TX_HASH'],
        TX_VOUT:            executionData['TX_VOUT'],
        FORMAT:             prepared.emissionFormat,
        IS_EMISSION:        true,
        // Propagated from a guard run's emission context (false for normal EXECUTE emissions,
        // which ARE still subject to their token's controller). Lets maybeRunControllerGuard
        // skip re-guarding a controller's emission of its own controlled token.
        IS_GUARD_EMISSION:  executionData['IS_GUARD_EMISSION'] ? true : false,
        // Per-TRANSACTION top-level issuance budget (EMISSION_ISSUANCE_LIMITS),
        // seeded in actions/index.js. Threaded by REFERENCE so this emission, its siblings and
        // every nested EXECUTE below it draw from ONE tally: copying the count here would
        // give each emission its own budget and re-open the hole the flag closes. Consumed
        // in issue.js. Undefined on any context that never passed through a transaction
        // (issue.js then enforces nothing, which is the pre-flag behaviour).
        ISSUANCE_LIMIT_LEDGER: executionData['ISSUANCE_LIMIT_LEDGER'],
        EMITTER:            executionData['CONTRACT_ACTION_INDEX'],
        EMITTER_POSITION:   position,   // index within this EXECUTE's emission list; used by ATTEST v0 (request) to verify deterministic request_id
        // The EMITTING execution's call-path. Disambiguates nested runs of the same
        // contract within one tx in the ATTEST request_id / XCALL call_id derivation,
        // content-derived so it is byte-stable across nodes/reorgs ('' for the root).
        EMITTER_PATH:       routing.emitterPath,
        // Per-root discriminator: the on-chain output index TX_VOUT of the root that seeded
        // this subtree, under the ROOT_ACTION_INDEX key attest.js/xcall.js read. Bound (with
        // EMITTER_PATH) into the ATTEST request_id / XCALL call_id re-derivation, and inherited
        // unchanged by a nested EXECUTE emission.
        ROOT_ACTION_INDEX:  routing.rootActionIndex,
        // This emission's OWN call-path: if it is itself a nested EXECUTE, its
        // execution runs at this path (threaded into vm.execute as callPath).
        CALL_PATH:          routing.childPath,
        CALL_DEPTH:         bounds.callDepth,
        VM_GAS_LIMIT:       bounds.nestedGasLimit, // null for every non-EXECUTE emission
        // Hop budget threads through same-chain emissions too: a contract calling a
        // local library which then crossExecutes still counts against the same cap.
        CROSS_HOPS:         bounds.crossHops
    };
}

async function dispatchEmission(emission, action, actionParams, emissionData){
    // Route to the correct handler
    let handler = this.getActionHandler(action);
    if(!handler)
        throw new Error('unknown emission action: ' + action);

    // Parse through the existing handler; same validation as user-submitted actions.
    let emissionError = null;
    await handler.parse(actionParams, emissionData, emissionError);

    // Check handler result
    if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid')
        throw new Error(action + ': ' + emissionData['STATUS']);

    // Store the resulting action_index for the emission record
    emission.resultActionIndex = emissionData['ACTION_INDEX'];

    // Cross-contract callee settled: hand its unused reservation
    // (gasLimit - billed, subtree-netted) back to the calling parse loop.
    if(action === 'EXECUTE')
        emission.gasUnusedSubtree = Number(emissionData['VM_GAS_UNUSED_SUBTREE']) || 0;
}

/*****************************************************************
 * Emission Processing - Routes emitted actions to existing handlers
 ****************************************************************/

async function processEmission(emission, executionData, position, limits){
    let action = emission.action;
    let params = emission.params;

    await assertEmissionPermitted.call(this, executionData, action);
    assertEmitterPosition(action, position);
    let bounds  = validateEmissionBounds(action, params, executionData, limits);
    let routing = await deriveEmissionRouting.call(this, executionData, position);

    let prepared = await prepareEmissionParams.call(this, action, params, executionData);
    let emissionActionIndex = await createEmissionActionIndex.call(this, action, executionData, prepared);
    let emissionData = buildEmissionData(executionData, position, prepared, bounds, routing, emissionActionIndex);

    await dispatchEmission.call(this, emission, action, prepared.actionParams, emissionData);
}

// Normalize every amount-bearing field of an emitted action to its tick's decimals,
// using the SAME normalization the ledger applies at write time
// (createLedgerChangeRecord -> util.bcadd(amount, 0, decimals)). This makes a contract's
// over-precise computed amount tick-precise before it reaches the action handler, so it
// passes isValidAmountFormat and the stored action amount matches the ledger row. Mutates
// and returns `params`. Fields that are null/empty are left as-is; a tick unknown locally
// (e.g. an ORDER/SWAP get-leg on a foreign chain) is left untouched because that leg is
// validated on the far chain. ISSUE uses its inline declared decimals (the tick is not in
// the issues table yet). Driven by EMISSION_AMOUNT_FIELDS; keep that map in sync with
// buildActionParams (enforced by the emission-map coverage test).
async function truncateEmissionAmounts(action, params){
    let fields = EMISSION_AMOUNT_FIELDS[action];
    if(!fields || !params) return params;
    for(let f of fields){
        let value = params[f.amount];
        if(this.util.isNull(value) || String(value) === '') continue;
        let decimals;
        if(f.declared){
            decimals = parseInt(params.decimals);
            if(!Number.isFinite(decimals)) continue;
        } else {
            // `gas: true` fields are denominated in the chain's fixed GAS tick
            // rather than a tick named by another param (VOTE deposit/gasEscrow).
            let tick = f.gas ? this.config['GAS'] : params[f.tick];
            if(this.util.isNull(tick) || String(tick) === '') continue;
            let tickId = await this.indexerDb.getTickerId(tick);
            if(tickId === null) continue;
            decimals = await this.indexerDb.getTokenDecimalPrecision(tickId);
        }
        // bcstr, not String(): a truncated dust amount below 1e-7 would render
        // exponentially ("3e-8") and fail the handler's format validation.
        params[f.amount] = this.util.bcstr(this.util.bcadd(value, 0, decimals));
    }
    return params;
}

module.exports = { EMISSION_AMOUNT_FIELDS, processEmission, truncateEmissionAmounts };

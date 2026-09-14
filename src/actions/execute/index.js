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
 * XChain Platform Action - EXECUTE
 *
 * This action executes a method on a deployed smart contract.
 *
 * PARAMS:
 * - VERSION              - Format Version
 * - CONTRACT_ACTION_INDEX - Action index of the deployed contract
 * - METHOD               - Method name to call
 * - PARAMS               - Method parameters (pipe-delimited after method)
 *
 * FORMATS:
 * - 0 = Execute a contract method
 *
 ********************************************************************/

const ProviderRegistry = require('../../attestation/providerRegistry.js');

// Per-provider deadline windows are built per instance in the constructor
// (this.providerDeadlineWindows) from the CONFIGURED registry. A module-scoped
// snapshot cannot see config.ATTESTATION.PROVIDERS, so the VM enforced DEFAULTS
// while attest.js validated against the overlay, letting the VM accept a request
// the indexer then rejects.

// Gas ceiling for a top-level EXECUTE. Must match the gasCeiling the VM is
// constructed with in actions/index.js. Module-scoped rather than local to parse(),
// because processEmission validates against the same ceiling.
const GAS_CEILING = 1000000;

// Cross-contract call protocol constants. Vendored single source of truth:
// ../protocol/constants.js (byte-identical to xchain-documentation/protocol/
// constants.js, VM_MAX_CALL_DEPTH / VM_MIN_CALL_GAS). The VM enforces both at
// emit time (gateway-emit.js); these host-side checks are defense in depth so
// an older/compromised bundled VM cannot bypass them.
const PROTO = require('../../protocol/constants.js');
const MAX_CALL_DEPTH = PROTO.VM_MAX_CALL_DEPTH;
const MIN_CALL_GAS   = PROTO.VM_MIN_CALL_GAS;

// Cross-chain call (XCALL) host-side guards. Read from the vendored protocol
// constants rather than re-exported through actions/xcall, which is where
// actions/xcall reads them too: an action that requires another action makes
// the two load-order dependent and hides that the constants are protocol data,
// not xcall's to own (canonical: xchain-documentation/protocol/constants.js).
const XCALL_MIN_GAS  = PROTO.XCALL_MIN_GAS;
const XCALL_MAX_GAS  = PROTO.XCALL_MAX_GAS;
const XCALL_MAX_HOPS = PROTO.XCALL_MAX_HOPS;

// The protocol limits above, handed to the phase modules below as one argument
// rather than re-derived inside each of them. Every value here is protocol data
// with a single home (the vendored constants module), and deriving it once is what
// keeps the ceiling the VM runs against, the host's re-check of an emitted call and
// the fee settlement reading the same number.
const LIMITS = { GAS_CEILING, MAX_CALL_DEPTH, MIN_CALL_GAS, XCALL_MIN_GAS, XCALL_MAX_GAS, XCALL_MAX_HOPS };

const { SYNTH_EXEC_TX_HASH } = require('../../consensus/exec_context.js');
// The SLASH emission writer, shared with actions/deploy (a constructor emits SLASH too).
// Held as the module object rather than destructured so the call resolves at call time.
const slashEmission = require('./slash_emission.js');

// The phases of this handler. Each part is invoked with the handler as its receiver
// (fn.call(this, ...)), so every method below stays a real method on Execute.prototype:
// a suite that stubs or borrows one reaches the same function it always did, and the
// parts read this.indexerDb / this.util / this.actions unchanged.
const validate        = require('./validate.js');
const fees            = require('./fees.js');
const runVm           = require('./run_vm.js');
const settle          = require('./settle.js');
const controllerGuard = require('./controller_guard.js');
const emissionRouter  = require('./emission.js');
const actionParams    = require('./action_params.js');

class Execute {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Per-provider deadline windows injected into the VM gateway so a contract's
        // attestation.request() rejects an over-limit deadlineBlocks at call time rather
        // than landing on-chain and being silently rejected here by the DEADLINE check.
        // Built from the CONFIGURED registry, the same construction attest.js uses, so the
        // VM cap and the host cap cannot drift under a config.ATTESTATION.PROVIDERS overlay.
        this.providerDeadlineWindows = new ProviderRegistry(this.config).getDeadlineWindows();

        // Monotonic per-instance ordinal appended to each controller-guard
        // savepoint name so every guard invocation gets a globally-unique name
        // within the transaction. (action_index, contractIndex, seq) alone can
        // repeat: up to three guards run on one SEND leg sharing the leg's seq,
        // and two can share a contractIndex (token-controller == address-controller,
        // or a self-send), so they would otherwise build the same name. The name
        // is a transaction-local artifact (never hashed, replicated, or persisted),
        // so a per-process counter that diverges across nodes is harmless.
        this.guardSavepointCounter = 0;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...';
    }

    // Handle parsing the EXECUTE transaction
    async parse(params, data, error){

        await validate.assertExecContextTxHash.call(this, data, SYNTH_EXEC_TX_HASH);

        // One context threads the phases below, each reading what the one before it
        // decided: the first rejection (ctx.error, which every later phase stands down
        // on), the fee mode and the amounts the settlement bills, and the VM run's
        // outcome, from which the execution record and the ledger debit are derived.
        // `data` travels in it because the number-format pass inside the validation
        // phase is free to hand back a different object.
        let ctx = {
            data:            data,
            error:           error,
            contractInfo:    null,
            gasCost:         null,
            fee:             null,
            gas:             null,
            tokenInfo:       null,
            balances:        null,
            feePaymentMode:  2,
            skipFee:         false,
            execCeiling:     null,
            gasUsed:         null,
            gasBilled:       null,
            emittedCount:    0,
            nestedGasUnused: 0,
            vmError:         null,
            vmReturnValue:   null
        };

        await validate.validateExecute.call(this, ctx, params);
        await fees.chargeGasFee.call(this, ctx);
        await validate.validateSourceAwake.call(this, ctx);
        await runVm.runVmExecution.call(this, ctx, LIMITS);
        await settle.settleExecution.call(this, ctx);
    }

    /*****************************************************************
     * Controller-bound token guard
     *
     * Runs the `guard` method on a token's bound CONTROLLER contract before a
     * guarded native action (SEND/ORDER/SWAP/DISPENSER) on that token settles.
     * The guard is a fully programmable VM execution: it may read/write its own
     * contract state and emit token actions (e.g. split a royalty out of sale
     * proceeds), and it may `revert` to DENY the action. The asynchronous
     * frameworks (ATTEST/XCALL) are disabled (VM isGuard mode) so the decision
     * is synchronous. Reuses the EXECUTE state-write + processEmission + savepoint
     * machinery so a guard's side effects are validated and atomic exactly like
     * a contract method's.
     *
     * opts:
     *   actionType      string  SEND | ORDER_CREATE | ORDER_MATCH | SWAP_CREATE |
     *                           SWAP_MATCH | DISPENSER_CREATE | DISPENSE
     *   controllerIndex number  the token's CONTROLLER (contract action_index)
     *   tick            string  the controlled token
     *   from, to        string  counterparties (action-type dependent; '' if n/a)
     *   amount          string  token amount moving (or order/dispenser quantity)
     *   price           string  proceeds amount for a sale ('' for a plain SEND)
     *   proceedsTick    string  proceeds tick for a sale ('' for a plain SEND)
     *   hostData        object  the native action's BLOCK / TX / ACTION_INDEX / SOURCE fields
     *   callDepth       number  guard call depth (native action depth + 1)
     *
     * Returns { allow, reason, gasBilled }. On allow the caller bills gasBilled
     * GAS to the action SOURCE (which it must already have reserved
     * GAS_SCHEDULE.VM_GUARD_GAS_CEILING fee for). On deny the caller marks the
     * native action invalid; the guard's own state + emissions are rolled back
     * here. Fail-closed: missing/throwing `guard`, out-of-gas, or a failed guard
     * emission all DENY. Depth-capped by VM_MAX_CALL_DEPTH.
     ****************************************************************/
    async runControllerGuard(opts){
        return controllerGuard.runControllerGuard.call(this, opts, LIMITS);
    }

    /*****************************************************************
     * Emission Processing - Routes emitted actions to existing handlers
     ****************************************************************/

    async processEmission(emission, executionData, position){
        return emissionRouter.processEmission.call(this, emission, executionData, position, LIMITS);
    }

    // Map action names to handler instances (./action_params.js)
    getActionHandler(action){
        return actionParams.getActionHandler.call(this, action);
    }

    // Convert emission params object to positional array for each action type.
    // MUST match the format strings in each handler's this.formats[0]. The per-action
    // mappings live in ./action_params.js by family; what stays here is the label for
    // every emittable action, because this switch IS the emittable set: the truncation
    // coverage guard (test/unit/execute_emission_truncation.test.js) reads these case
    // labels off this function to check that every action a contract can emit is
    // either amount-mapped or declared amountless. Moving the labels into the family
    // functions would leave that guard reading an empty set and passing on anything.
    // Touches no instance state: the arity guard borrows it off the prototype with a
    // null `this` to compare each action's params against that handler's format
    // without building the loader.
    buildActionParams(action, params){
        switch(action){
            case 'VOTE': case 'SEND': case 'DESTROY': case 'ISSUE': case 'MINT':
                return actionParams.tokenEmissionParams(action, params);
            case 'ORDER': case 'DISPENSER': case 'DIVIDEND': case 'AIRDROP':
                return actionParams.marketEmissionParams(action, params);
            case 'CALLBACK': case 'FILE': case 'LIST': case 'COINPAY': case 'SWEEP':
            case 'LINK': case 'BROADCAST': case 'MESSAGE':
                return actionParams.contentEmissionParams(action, params);
            case 'ATTEST': case 'EXECUTE': case 'XCALL':
                return actionParams.frameworkEmissionParams(action, params);
            default:
                throw new Error('unsupported emission action: ' + action);
        }
    }

    // Normalize every amount-bearing field of an emitted action to its tick's
    // decimals before the handler sees it (./emission.js).
    async truncateEmissionAmounts(action, params){
        return emissionRouter.truncateEmissionAmounts.call(this, action, params);
    }

    // The writer lives in ./slash_emission.js because a DEPLOY constructor emits SLASH
    // too: both call sites require the shared module rather than either one reaching
    // into the other handler's instance. It stays a method here so the EXECUTE path
    // below and its suites call the writer with this handler as the receiver.
    async processSlashEmission(emission, data, slashPosition, slashLedger){
        return slashEmission.processSlashEmission.call(this, emission, data, slashPosition, slashLedger);
    }
}

// Exposed for the emission-map coverage test (keeps EMISSION_AMOUNT_FIELDS in sync with
// buildActionParams without copying the map into the test).
Execute.EMISSION_AMOUNT_FIELDS = emissionRouter.EMISSION_AMOUNT_FIELDS;

module.exports = Execute;

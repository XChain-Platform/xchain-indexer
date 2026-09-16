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
 * XChain Indexer - Actions class
 * 
 * This class loads up all action classes and sets up handlers to process transactions
 *
 * The XChain Indexer actions are defined in the specifications at :
 * https://github.com/XChain-Platform/xchain-documentation/blob/master/actions/README.md
 * 
 ********************************************************************/

// Actions the PUBLIC feequote pre-flight refuses to dry-run. DEPLOY/EXECUTE run
// caller-supplied code in the VM (up to the VM CPU cap) while the dry-run holds the shared
// transaction mutex, XEXEC re-runs a target contract, and BATCH can smuggle any of them as
// a sub-action; quoting these on a shared node would hand unauthenticated callers a
// block-loop-stalling compute primitive. The raw `feequotedryrun` RPC (regtest +
// INDEXER_ENABLE_DRYRUN + API key) has no such restriction.
const FEE_QUOTE_DENYLIST = new Set(['DEPLOY', 'EXECUTE', 'XEXEC', 'BATCH']);

// Denied actions that still get a FEE-ONLY quote, priced from the gas schedule with no VM
// The old blanket answer was `supported:false` + "pay the fee in XCHAIN", which is
// BTC-era advice: LTC/DOGE settle the protocol fee in native coin and have no XCHAIN fee lane,
// so a denied action there was composable but literally unpayable (no way to size the required
// output), and any client offering it burned a network fee on a guaranteed-invalid action.
//
// Safe because the fee these two stage is decided BEFORE the VM runs and is pure arithmetic
// over the gas schedule: deploy.js charges VM_DEPLOY_BASE + codeBytes * VM_DEPLOY_PER_BYTE and
// execute.js charges VM_EXECUTE_BASE, and that pre-VM number is exactly what
// validateNativeCoinFee judges the native output against (the post-VM recalculation from metered
// gas re-prices the recorded fee, never the acceptance rule). So a static quote reproduces the
// acceptance rule byte-for-byte while never entering the VM: no dry-run, no mutex, no compute
// primitive. What it CANNOT answer is on-chain validity (class-B: contract exists, source has
// funds, code compiles), so the quote reports `valid: null` and `validated: false` rather than
// claiming a verdict it did not compute.
//
// XEXEC and BATCH stay fee-unquotable: XEXEC is system-injected from the cross-chain mirror
// (never wallet-broadcast, so there is no caller to quote for), and a BATCH's fee is the sum of
// its sub-actions' state-dependent fees, which cannot be priced without running them. Quoting a
// BATCH from a partial schedule would under-size the output, which is the same funds-burning
// direction this closes.
//
// Served on the PRICING path (computeFeeQuote) only, never on validity-first computePreflight,
// which carries no pricing fields by design; callers reach it via the SDK's getFeeQuote.
const FEE_QUOTE_STATIC = new Set(['DEPLOY', 'EXECUTE']);

// Actions that can reach the VM but that classifyFeeQuoteAction does NOT already mark 'denied'.
// Used only by the BATCH sub-command pre-flight (isBatchProbeForbiddenSubAction): the batch probe
// dispatches REAL sub-handlers, so "denied at top level" is not a wide enough net - an action the
// top-level gate lets through for its own reasons still enters the VM when a batch runs it.
//   ATTEST - v1 response injects a callback EXECUTE (attest.js injectCallbackExecute).
//   VOTE   - a v2 finalize on a binding poll injects a callback EXECUTE (vote.js
//            injectCallbackExecute), and VOTE is 'quotable', so the fee-quote classes do not
//            cover it. That reach is NOT open today: vote.js refuses a v2 whose data is not
//            IS_SYNTHETIC, which no probe sets, so this is defence in depth rather than a fix.
//            It is deliberately kept anyway: that refusal exists to stop a user finalizing
//            someone else's poll, which is a different question from "may an unauthenticated
//            dry-run enter the VM", and relaxing it would silently open this door. The cost is
//            named honestly: a batch of legitimate VOTE v0/v1 sub-commands loses its
//            pre-flight, which is the safe direction of a real parity trade.
//   XCALL  - injects a callback EXECUTE (xcall.js). Already 'exempt', listed so the set is a
//            complete statement of VM reach rather than a residue of another gate's choices.
// Kept as an explicit literal, and bound to the dispatch table by
// test/unit/action_manifest_conformance.test.js so a new action cannot default into 'allowed'.
const PROBE_VM_REACHING_ACTIONS = new Set(['ATTEST', 'VOTE', 'XCALL']);

// Settlement and lifecycle legs that stage NO protocol fee: the fee was already charged when
// the originating ORDER/SWAP/DISPENSER was created, so there is nothing for feequote to price.
// They also can't be dry-run through the synthetic-tx harness: COINPAY/DISPENSE only settle
// against a native-coin output paying a specific payee/dispenser (coinpay.js/dispense.js
// early-exit "skip" when it's absent), and the *_MATCH/*_EXPIRE/*_CLOSE/CROSS_SETTLE/XCALL
// actions are system-synthesized during block processing, never wallet-broadcast (XCALL is
// VM-emitted/synthetic-only, like CROSS_SETTLE). Quoting any of them would fall through to a
// misleading `dry-run produced no status`; instead answer honestly with a zero-fee, feeExempt
// result. This is a read-only preflight classification, never a consensus path: it changes
// what the quote reports, not what a handler charges on-chain.
// ATTEST is exempt (not denylisted) because it stages no wallet-priceable fee AND must never
// dry-run on the public path: ATTEST v0 is VM-emission-only, and ATTEST v1 (validator response)
// injects a contract callback EXECUTE (attest.js injectCallbackExecute) that enters the VM while
// the dry-run holds the block-loop mutex. Its protocol fee is charged at the v0 request origin and
// settled by settleRequestFee, so there is nothing for feequote to price; exempting it short-
// circuits classifyFeeQuoteAction before dryRunAction, closing the unauthenticated VM-compute-
// under-mutex reachable by replaying a pending v1 response's mempool bytes into feequote/preflight.
const FEE_QUOTE_EXEMPT = new Set([
    'COINPAY', 'DISPENSE',
    'COINPAY_EXPIRE', 'ORDER_MATCH', 'ORDER_EXPIRE', 'SWAP_MATCH', 'SWAP_EXPIRE',
    'DISPENSER_CLOSE', 'DISPENSER_EXPIRE', 'CROSS_SETTLE', 'XCALL', 'ATTEST',
    'BET_EXPIRE'
]);

// ACTION aliases, expanded to canonical names before any gate. Single module-level source of
// truth: the constructor copies this via Object.assign into `this.actionAliases`, and
// classifyFeeQuoteAction normalizes through this same constant, so the fee-quote classifier
// de-aliases exactly as dispatch does. The conformance test binds ACTION_ALIASES to the manifest.
const ACTION_ALIASES = {
    // Legacy BRC20 formats
    'TRANSFER': 'SEND',
    // Short aliases
    'ADDR': 'ADDRESS',
    'DROP': 'AIRDROP',
    'CAST': 'BROADCAST',
    'MSG':  'MESSAGE'
};

// Pure classifier bound to the fee-quote deny/exempt sets. Applies the SAME normalization
// computeFeeQuote uses (trim, uppercase, single-pass de-alias), then returns exactly one of
// 'denied' | 'exempt' | 'quotable'. Deny-before-exempt ordering is preserved so this is the one
// classification path both the public feequote gate and the conformance test read.
function classifyFeeQuoteAction(action){
    let a = String(action == null ? '' : action).trim().toUpperCase();
    if(Object.prototype.hasOwnProperty.call(ACTION_ALIASES, a))
        a = ACTION_ALIASES[a];
    if(FEE_QUOTE_DENYLIST.has(a)) return 'denied';
    if(FEE_QUOTE_EXEMPT.has(a))   return 'exempt';
    return 'quotable';
}

// True for a sub-action a BATCH pre-flight must never dispatch on the public probe path.
//
// The public BATCH pre-flight (computePreflight) runs the REAL batch handler under a forced
// rollback while holding the block-loop transaction mutex, so anything it dispatches runs for
// real minus the commit. FEE_QUOTE_DENYLIST alone is the wrong net twice over: it is not a
// statement about VM reach (BATCH is on it because it can SMUGGLE one, not because it runs
// code) and it lets through actions that are 'exempt'/'quotable' for unrelated reasons and
// still inject an EXECUTE. So the refusal is the UNION of the denylist and the explicit
// VM-reach set above, applied to the SAME normalization dispatch uses.
//
// This is the reason BATCH may be pre-flighted at all: it replaces "lift BATCH out of the
// denylist" (which re-opens exactly the unauthenticated VM-compute-under-mutex the denylist
// exists to close) with a per-sub-command refusal. It is checked TWICE on purpose - once as a
// wire-string pre-scan before the mutex is ever taken (batchProbeForbiddenSubAction) and once
// inside batch.js's dispatch loop against the exact name being dispatched. The second is the
// load-bearing one: it reads the variable passed to processAction, after alias rewrite and
// case folding, so no spelling can route around it.
function isBatchProbeForbiddenSubAction(action){
    let a = String(action == null ? '' : action).trim().toUpperCase();
    if(Object.prototype.hasOwnProperty.call(ACTION_ALIASES, a))
        a = ACTION_ALIASES[a];
    return FEE_QUOTE_DENYLIST.has(a) || PROBE_VM_REACHING_ACTIONS.has(a);
}

// Load indexer actions: every handler class, constructed onto the instance by the two
// wiring runs in actions_class/handler_wiring.js.
const { wireCoreHandlers, wireProtocolHandlers } = require('./actions_class/handler_wiring.js');
// DEPLOY's canonical MAX_CODE_SIZE sizes the VM isolate (vmOptions below).
const deploy = require('./deploy/index.js');

// VM runtime
let XChainVM;
let vmLoadError = null;
try {
    XChainVM = require('xchain-vm');
} catch(e) {
    // Held, not logged-and-forgotten: the constructor turns it into a boot refusal
    // (assertVmRuntimeLoadable) so the loader's own text reaches the operator once,
    // attached to the reason the process is exiting.
    vmLoadError = e;
}

// VM boot gates and their diagnostics, pure so each is unit-testable (actions_class/vm_runtime.js).
const vmRuntime = require('./actions_class/vm_runtime.js');
const { assertVmRuntimeLoadable, assertConsensusRuntime } = vmRuntime;

// Actions.prototype methods kept beside this loader, one file per concern, mixed in below
// the class the way db/index.js assembles Database from its table-family mixins.
const transactionMethods = require('./actions_class/transaction.js');
const addressPrePass     = require('./actions_class/address_pre_pass.js');
const feePricingMethods  = require('./actions_class/fee_pricing.js');
const feeViewMethods     = require('./actions_class/fee_views.js');
const dispatchMethods    = require('./actions_class/dispatch.js');
const installMethods     = require('./actions_class/install_methods.js');

// The dry-run engine and both public read-only surfaces, bound below to the fee-quote policy above.
const quoteSurfaceMethods = require('./actions_class/quote_surfaces.js');

const PreflightMemo      = require('../chain/preflight_memo.js');

const { CONFIG_ENV } = require('../config.js');

// Construction options for the contract VM (the constructor builds this.vm from them).
function vmOptions(config){
    return {
        // Run every contract in a forked worker process. A contract that
        // aborts the V8 engine (process-wide SIGABRT, e.g. a bulk allocation that
        // bypasses the isolate memory limit) then crashes only the worker,
        // never this indexer; the executor returns a deterministic
        // resource-failure result (gasUsed = ceiling) and respawns, so the
        // block still advances. REQUIRES the bundled xchain-vm to support
        // process isolation (process-executor.js / vm-worker.js).
        execution:   'subprocess',
        gasSchedule: config['GAS_SCHEDULE'],
        gasCeiling:  1000000,
        limits: {
            // NOT the binding wall-clock constraint: at/after the VM's flag-day every
            // node runs one execution against the consensus constant
            // CONSENSUS_MAX_WALL_MS (xchain-vm src/consensus-wall-clock.js) whatever
            // this says, because a per-node budget made status and gasUsed (fee
            // debit, contract checkpoint) an operator setting. Kept equal to the
            // constant so this indexer's ungated/legacy-replay path behaves the same
            // as its gated one; changing it moves neither.
            maxCpuTimeMs:      30000,
            maxMemory:         8,
            maxEmissions:      50,
            maxStateKeys:      10000,
            maxStateValueSize: 65536,
            // Canonical MAX_CODE_SIZE: single-sourced from deploy.js (which
            // pins xchain-documentation/protocol/constants.js) so the isolate
            // limit can never drift from the DEPLOY-time byte-length check.
            maxCodeSize:       deploy.MAX_CODE_SIZE
        }
    };
}

class Actions {

    constructor(indexer){
        this.config    = indexer.config;
        this.util      = indexer.util;
        this.mapper    =  indexer.mapper;
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;
        this.hubDb     = indexer.hubDb || null;

        // hub client pushes PRICE data to xchain-hub
        this.hubClient = indexer.hubClient || null;

        this.protocolChanges = indexer.protocolChanges;

        // utxo-tracker client used by DISPENSER fresh-address check
        this.utxoTracker = indexer.utxoTracker || null;

        // Public validity-first pre-flight verdict memo, keyed on
        // (action, params, source, blockIndex); a new tip changes the key.
        this._preflightMemo = new PreflightMemo(
            parseInt(CONFIG_ENV.INDEXER_PREFLIGHT_MEMO_MAX, 10) || 256);

        // Create action instances and pass database connections
        wireCoreHandlers(this);

        // VM runtime: refuse at boot when it could not load (see assertVmRuntimeLoadable).
        assertVmRuntimeLoadable(XChainVM, vmLoadError);

        this.vm = new XChainVM(vmOptions(this.config));

        // Consensus-runtime gate: fail CLOSED on an off-pin engine.
        assertConsensusRuntime(XChainVM);

        // VM, staking, PRICE, attestation, ANCHOR, NODEPROOF, ROLLCALL, cross-chain call and
        // bridge handler instances, wired only once the VM above is loaded and gated.
        wireProtocolHandlers(this);

        // ACTION aliases: copied from the single module-level ACTION_ALIASES source (it
        // was a hand-duplicated literal block that the 'single source of truth' comment
        // falsely claimed was a copy). Dispatch de-aliases through this.actionAliases and
        // classifyFeeQuoteAction through ACTION_ALIASES; both now derive from one constant.
        this.actionAliases = Object.assign({}, ACTION_ALIASES);

        // Lightweight in-process observability counters: accepted and rejected counts per
        // ACTION type, accumulated since this instance started. Pure in-memory, never
        // persisted, and never read on the consensus-hashed path, so they cannot affect
        // ledger output. Exposed via getActionCounters() for the health endpoint.
        this._actionCounters = {};

    }

    // The BATCH probe-path sub-action refusal, reached by batch.js through the loader instance it
    // is constructed with, so that action never requires this loader (a load-time cycle) and the
    // policy stays defined once, beside the dispatch tables it reads.
    isBatchProbeForbiddenSubAction(action){
        return isBatchProbeForbiddenSubAction(action);
    }

}

// Install the split-out method families on the prototype NON-ENUMERABLE, the shape the class
// body they came from produced (see actions_class/install_methods.js).
installMethods(Actions.prototype, [transactionMethods, addressPrePass, feePricingMethods, feeViewMethods, dispatchMethods,
    quoteSurfaceMethods({ classifyFeeQuoteAction, isBatchProbeForbiddenSubAction, FEE_QUOTE_STATIC, CONFIG_ENV })]);

// Static members ride on the class, so module.exports keeps one shape: the class itself.
Object.assign(Actions, {
    // Pure fee-quote classifier and read-only views of the deny/exempt sets, exported for the
    // ActionManifestConformance test to bind classification to the dispatch table. The getters
    // return fresh Sets so callers cannot mutate module state.
    classifyFeeQuoteAction: classifyFeeQuoteAction,
    getFeeQuoteDenylist:    () => new Set(FEE_QUOTE_DENYLIST),
    getFeeQuoteExempt:      () => new Set(FEE_QUOTE_EXEMPT),
    getFeeQuoteStatic:      () => new Set(FEE_QUOTE_STATIC),
    // The BATCH probe-path sub-action refusal, exported for the conformance test that binds the policy
    // to the dispatch table and for test contexts that stand in for this loader. batch.js itself reaches
    // it through the Actions instance method above, never by requiring this module (actions/index.js
    // requires batch.js, so a load-time require would resolve to an empty exports object).
    isBatchProbeForbiddenSubAction: isBatchProbeForbiddenSubAction,
    getProbeVmReachingActions:      () => new Set(PROBE_VM_REACHING_ACTIONS),
    // Pure consensus-runtime gate, exported so its fail-closed contract is unit-testable
    // without a real off-pin engine.
    assertConsensusRuntime: assertConsensusRuntime,
    // Pure VM-load boot gate and its message builder, exported so the refusal (and the text that
    // names the binding/platform mismatch) is testable without a foreign binding on disk.
    assertVmRuntimeLoadable: assertVmRuntimeLoadable,
    describeVmLoadFailure:   vmRuntime.describeVmLoadFailure,
    bindingObjectFormat:     vmRuntime.bindingObjectFormat,
    bindingPathFromError:    vmRuntime.bindingPathFromError,
    collectVmRuntimeEnv:     vmRuntime.collectVmRuntimeEnv
});

module.exports = Actions;

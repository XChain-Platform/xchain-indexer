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

// How long a public read-only dry-run waits for the block-processing transaction mutex before
// giving up. The default is deliberately well under the explorer's own 5s hop cap,
// because the whole point is that the indexer's structured "busy, retryable" answer wins the
// race against the proxy's transport timeout: losing it is what turned a block-processing
// overlap into a bare 502 UPSTREAM_ERROR and a refused compose in the wallet. It is also
// comfortably above a healthy block's processing time, so on a healthy venue nothing changes.
// Raising it past the hop cap re-creates the 502 it removes.
function feeQuoteAcquireBudgetMs(){
    return parseInt(CONFIG_ENV.INDEXER_FEEQUOTE_ACQUIRE_TIMEOUT_MS, 10) || 2000;
}

// True for the give-up thrown by a bounded transaction-mutex acquire (db.acquireTxLock).
function isTxLockBusy(e){
    return !!(e && e.code === 'TX_LOCK_BUSY');
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

// Pure parts of the dry-run engine and of the two public read-only surfaces, taking the
// instance explicitly so a context that borrows one prototype method still works.
const dryRunSupport = require('./actions_class/dry_run_support.js');
const quoteAnswers  = require('./actions_class/quote_answers.js');
const { syntheticDryRunTx, sourceFeeBalanceOrNull, quietAbandonedRun, readDryRunVerdict, dryRunOutcome } = dryRunSupport;
const { normalizeQuoteRequest, feeQuoteBase, exemptFeeQuote, feeQuoteLockBusy, dryRunVerdictQuote } = quoteAnswers;
const { resolvePreflightFeeMode, preflightGateAnswer, preflightLockBusy, preflightResult } = quoteAnswers;

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

// The handler dispatch table, in two runs so neither is one long function. Module functions
// called with the Actions instance as `this` (see processAction) rather than class methods,
// so a context that borrows only Actions.prototype.processAction still dispatches. Every
// line keeps the `if(action=='X') await this.<handler>.parse(` shape: the manifest
// conformance test reads that shape out of this file as the dispatch table.
async function dispatchCoreAction(action, params, data, error){
    if(action=='ADDRESS')            await this.actionAddress.parse(params, data, error);
    if(action=='AIRDROP')            await this.actionAirdrop.parse(params, data, error);
    if(action=='BATCH')              await this.actionBatch.parse(params, data, error);
    if(action=='BET')                await this.actionBet.parse(params, data, error);
    if(action=='BET_EXPIRE')         await this.actionBetExpire.parse(params, data, error);
    if(action=='BROADCAST')          await this.actionBroadcast.parse(params, data, error);
    if(action=='CALLBACK')           await this.actionCallback.parse(params, data, error);
    if(action=='COINPAY')             await this.actionCoinpay.parse(params, data, error);
    if(action=='COINPAY_EXPIRE')     await this.actionCoinpayExpire.parse(params, data, error);
    if(action=='DESTROY')            await this.actionDestroy.parse(params, data, error);
    if(action=='DISPENSER')          await this.actionDispenser.parse(params, data, error);
    if(action=='DISPENSER_CLOSE')    await this.actionDispenserClose.parse(params, data, error);
    if(action=='DISPENSER_EXPIRE')   await this.actionDispenserExpire.parse(params, data, error);
    if(action=='DISPENSE')           await this.actionDispense.parse(params, data, error);
    if(action=='DIVIDEND')           await this.actionDividend.parse(params, data, error);
    if(action=='FILE')               await this.actionFile.parse(params, data, error);
    if(action=='ISSUE')              await this.actionIssue.parse(params, data, error);
    if(action=='LIST')               await this.actionList.parse(params, data, error);
    if(action=='LINK')               await this.actionLink.parse(params, data, error);
    if(action=='MINT')               await this.actionMint.parse(params, data, error);
    if(action=='MESSAGE')            await this.actionMessage.parse(params, data, error);
    if(action=='ORDER')              await this.actionOrder.parse(params, data, error);
    if(action=='ORDER_EXPIRE')       await this.actionOrderExpire.parse(params, data, error);
    if(action=='ORDER_MATCH')        await this.actionOrderMatch.parse(params, data, error);
    if(action=='SLEEP')              await this.actionSleep.parse(params, data, error);
    if(action=='SEND')               await this.actionSend.parse(params, data, error);
    if(action=='SWAP')               await this.actionSwap.parse(params, data, error);
    if(action=='SWAP_EXPIRE')        await this.actionSwapExpire.parse(params, data, error);
    if(action=='SWAP_MATCH')         await this.actionSwapMatch.parse(params, data, error);
    if(action=='CROSS_SETTLE')       await this.actionCrossSettle.parse(params, data, error);
    if(action=='SWEEP')              await this.actionSweep.parse(params, data, error);
    if(action=='UNKNOWN')            await this.actionUnknown.parse(params, data, error);
}

// VM, staking, oracle, attestation, anchor, cross-chain and validator-tier actions.
async function dispatchProtocolAction(action, params, data, error){
    // VM actions
    if(action=='DEPLOY')             await this.actionDeploy.parse(params, data, error);
    if(action=='EXECUTE')            await this.actionExecute.parse(params, data, error);
    if(action=='DEPOSIT')            await this.actionDeposit.parse(params, data, error);
    if(action=='WITHDRAW')           await this.actionWithdraw.parse(params, data, error);
    if(action=='VOTE')               await this.actionVote.parse(params, data, error);

    // Staking actions (DELEGATE handles both rotate v0/v1 and revoke v2/v3 internally)
    if(action=='STAKE')              await this.actionStake.parse(params, data, error);
    if(action=='UNSTAKE')            await this.actionUnstake.parse(params, data, error);
    if(action=='DELEGATE')           await this.actionDelegate.parse(params, data, error);
    if(action=='COLLECT')            await this.actionCollect.parse(params, data, error);
    if(action=='SLASH')              await this.actionSlash.parse(params, data, error);

    // PRICE action (validator snapshots and user oracles)
    if(action=='PRICE')              await this.actionPrice.parse(params, data, error);

    // Attestation framework: handler dispatches on VERSION (v0=request, v1=response, v2=expire)
    if(action=='ATTEST')             await this.actionAttest.parse(params, data, error);

    // ANCHOR: DOGE-only on-chain state commitments (handler dispatches on VERSION:
    // v0=checkpoint bundle, v1=archive head, v2=archive continuation chunk; the
    // pre-restart v3-v7 set no longer parses)
    if(action=='ANCHOR')             await this.actionAnchor.parse(params, data, error);

    // Cross-chain contract calls: XCALL (VM-emitted request / synthetic expiry),
    // XEXEC (system-injected, mirror-driven target-chain execution)
    if(action=='XCALL')              await this.actionXcall.parse(params, data, error);
    if(action=='XEXEC')              await this.actionXexec.parse(params, data, error);

    // Cross-chain token bridge: XBRIDGE (v0/v3 lock, v1/v4 burn; a broadcast v2/v5 is
    // refused here, the injected settle legs are applied by bridge_settle.js)
    if(action=='XBRIDGE')            await this.actionXbridge.parse(params, data, error);

    // Full-node possession-proof verdict (verified-validator tier)
    if(action=='NODEPROOF')          await this.actionNodeproof.parse(params, data, error);
    if(action=='ROLLCALL')           await this.actionRollcall.parse(params, data, error);
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

    // Generalized function to handle parsing and processing a specific ACTION
    // NOTE: If the action is UNKNOWN, fail silently (prevent crashing indexer on unsupported actions)
    async processAction(action, params, data, error){
        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        // ORDER_MATCH / SWAP_MATCH are dispatched by the ORDER / SWAP handler with the
        // ORIGINATING action's OWN record (order.js / swap.js), and they overwrite its
        // STATUS and ACTION_INDEX with the match's (order_match.js sets STATUS to
        // 'pending_coinpay' for a native-coin leg, and takes ACTION_INDEX for the match row).
        // On the real path that is invisible: the block loop discards processTransaction's
        // return value and every row was already written from the handler's own state. The
        // read-only fee-quote DRY RUN is its ONLY consumer, so without this snapshot it
        // reports the MATCH's verdict as the quoted action's - and an ORDER that fills
        // instantly against a native-coin counterparty is then quoted
        // `valid:false, error:"pending_coinpay", xchainFee:null`, i.e. indistinguishable from
        // a real rejection, for an action the chain accepts. That refused the taker side of
        // the whole CoinPay lane in every wallet that pre-flights (measured 2026-07-29 on LTC
        // regtest). Captured here rather than in the two handlers so one rule covers both, and
        // scoped per transaction by processTransaction above. These two actions are never
        // top-level: the decoder cannot produce them and the public quote deny-lists them.
        if((action == 'ORDER_MATCH' || action == 'SWAP_MATCH') && data && this._primaryVerdict == null)
            this._primaryVerdict = { status: data['STATUS'], actionIndex: data['ACTION_INDEX'] };

        // Deterministic index-id pre-pass: register the NEW wire-field addresses this
        // action introduces, in byte-sorted VALUE order, BEFORE the handler runs. This
        // pins each new address's index id to the VALUE it carries rather than to the
        // order the handler happens to intern it, so the wire ^<id> address form resolves
        // identically on every node and across code refactors. Runs after createActionIndex
        // (which already registered SOURCE first) and covers the BATCH path too, since
        // batch.js dispatches each sub-action back through processAction.
        await this.assignActionAddressIds(action, params, data, error);

        // Process the action with the correct handler (dispatchCoreAction, then
        // dispatchProtocolAction; at most one line of the two tables matches any ACTION).
        await dispatchCoreAction.call(this, action, params, data, error);
        await dispatchProtocolAction.call(this, action, params, data, error);

        // Increment the in-memory observability counter for this action type. STATUS
        // is 'valid' for accepted actions and an 'invalid: ...' string (or undefined
        // when an earlier gate short-circuits) for rejected ones. This read happens
        // AFTER the handler has written its final status, so the bucket is accurate.
        // Pure observability: not on any hashed path and not persisted.
        let bucket = this._actionCounters[action];
        if(!bucket){
            bucket = { accepted: 0, rejected: 0 };
            this._actionCounters[action] = bucket;
        }
        if(data['STATUS'] === 'valid')
            bucket.accepted++;
        else
            bucket.rejected++;
    }

    // Return a snapshot of the per-type accepted/rejected counters accumulated since
    // this process started. The caller receives a plain object (not a live reference)
    // so mutations outside this class cannot corrupt the counters. Surfaced by the
    // health endpoint as a lightweight operational signal; never on any consensus path.
    getActionCounters(){
        let out = {};
        for(let type of Object.keys(this._actionCounters)){
            let b = this._actionCounters[type];
            out[type] = { accepted: b.accepted, rejected: b.rejected };
        }
        return out;
    }

    // Run the REAL action handler for a proposed action against current committed state inside
    // a forced-rollback transaction, and extract the handler's verdict plus the
    // XCHAIN-denominated fee it staged (the `fees` row, read back before rollback discards it).
    // The single dry-run engine behind BOTH the public feequote pre-flight (computeFeeQuote)
    // and the raw regtest-only feequotedryrun RPC. Never persists; and because in-transaction
    // index_* ids are assigned dense-explicitly (db.createAddress/createTicker MAX(id)+1) they
    // roll back with the row, so a dry-run leaves no id skew. That retires the 06-18
    // unindexed-source refusal: quoting from a fresh (never-seen) address is a supported case.
    //
    // `feeOutputs` is the synthetic tx's native-coin output set. When the caller supplies none
    // and `probeFeeDestination` is set, a deliberately OVERSIZED fee output is injected so
    // LTC/DOGE's mandatory-native detection sees payment-mode 1 and the handler validates and
    // records the fee without an XCHAIN debit. The on-chain acceptance rule is lower-bound-only
    // (util.validateNativeCoinFee), so oversizing can never be the reason a quote rejects;
    // sizing the real output is the caller's job (computeFeeQuote prices the extracted fee).
    //
    // `feeBalanceTick` (optional) asks for the SOURCE's balance of that tick, read at
    // pre-action state inside the same transaction the handler runs in. Advisory only: it
    // never changes the verdict, and it degrades to null rather than failing the run.
    //
    // `acquireTimeoutMs` (optional) time-boxes the WAIT for the transaction mutex,
    // which `timeoutMs` never covered: it bounds the run only, and the run cannot start until
    // the block loop hands the mutex over. Set by the public read-only surfaces so they answer
    // busy-and-retryable rather than queueing behind a whole block; throws TX_LOCK_BUSY, with
    // no transaction opened and nothing to unwind.
    //
    // Returns { blockIndex, blockTime, status, error, xchainFee, sourceFeeBalance } where
    // xchainFee is the handler-recorded fee ('0' for a valid zero-fee action, null when the
    // run never got far enough to stage one).
    async dryRunAction({ action, params, source, feeOutputs, probeFeeDestination, timeoutMs, acquireTimeoutMs, label, guardInert, feeProbe, feeBalanceTick }){
        let blockIndex = await this.indexerDb.getLatestBlockIndex();
        let blockTime  = await this.indexerDb.getBlockTime(blockIndex);

        let syntheticTx = syntheticDryRunTx(this, { action, params, source, feeOutputs, probeFeeDestination,
                                                    blockIndex, blockTime, guardInert, feeProbe });

        let dryRunError = null, sourceFeeBalance = null;
        // Probe-only disclosures the BATCH pre-flight collects on `data` (batch.js seeds them
        // before its baseKeys snapshot, so the per-sub-command field clear preserves them).
        // Both stay null for every other action and for every decoded transaction.
        let verdict = { status: null, feeRecord: null, subCommands: null, oracleFeesOwed: null };
        // beginTransaction acquires the db transaction mutex (serializes against block processing
        // and reorgs); the finally guarantees rollback + lock release even on a handler throw.
        // Outside the try on purpose: a TX_LOCK_BUSY give-up opened no transaction, so it must
        // not reach the rollback below.
        await this.indexerDb.beginTransaction({ acquireTimeoutMs: acquireTimeoutMs });
        // Fence the dry-run's writes to THIS transaction's epoch, same as the block
        // loop: on watchdog timeout the finally below rolls back and bumps the epoch, but the
        // abandoned processTransaction can still resume and try to write on the shared
        // connection, which by then may belong to a REAL block's transaction. The stale epoch
        // rejects those zombie writes inside the db layer before they reach the driver.
        // runInDryRunEpoch, never runInTxEpoch: the fence is wanted here, consensus authority
        // is not. This IS a public unauthenticated path, and a barrier that keys on the
        // mere presence of a context reads this one as proof of a running block loop.
        let dryRunEpoch = this.indexerDb.currentTxEpoch();
        try {
            // The payer's fee-token balance, read under this transaction's epoch fence;
            // advisory, so a failed read is null (see sourceFeeBalanceOrNull).
            if(feeBalanceTick && !this.util.isNull(source))
                sourceFeeBalance = await sourceFeeBalanceOrNull(
                    (read) => this.indexerDb.runInDryRunEpoch(dryRunEpoch, read),
                    this.indexerDb, source, feeBalanceTick);
            // Bound the synthetic run. The dry-run holds the shared _txLock for the whole
            // handler, so a stuck handler would otherwise wedge block advancement for the full
            // hang; on timeout the catch+finally roll back and release the lock within the
            // caller's bounded window instead.
            let dryRunProcessing = this.indexerDb.runInDryRunEpoch(dryRunEpoch,
                () => this.processTransaction(syntheticTx));
            quietAbandonedRun(dryRunProcessing);
            let resultData = await this.util.withTimeout(
                dryRunProcessing,
                timeoutMs,
                label || ('feequote dry-run ' + (action || '')));
            await readDryRunVerdict(this, resultData, verdict);
        } catch(e){
            dryRunError = 'handler threw: ' + ((e && e.message) ? e.message : e);
        } finally {
            await this.indexerDb.rollbackTransaction();
        }

        return dryRunOutcome(blockIndex, blockTime, verdict, dryRunError, sourceFeeBalance);
    }

    // The denied-action answer for the public feequote. FEE_QUOTE_STATIC actions get a
    // real, payable fee sized from the gas schedule (see staticProtocolFee) so a client can build
    // the FEE_DESTINATION output on a native-fee chain; everything else keeps the flat refusal,
    // worded for the chain it is answering on (advising "pay it in XCHAIN" on LTC/DOGE, which have
    // no XCHAIN fee lane, is what made those actions unpayable rather than merely unverified).
    //
    // The engine is never invoked on this path, so `valid` is deliberately null, not true: a
    // sized fee is not a verdict. The one verdict this path CAN reach is a negative one (a caller-
    // supplied output below the band's minimum, or an input the handler rejects before the VM),
    // and those stay valid:false because they are computed, not assumed.
    async staticFeeQuote(base, action, params, feeOutputSats){
        if(!FEE_QUOTE_STATIC.has(action))
            return Object.assign(base, { supported: false, valid: false, denied: true,
                error: 'native fee pre-flight not supported for ' + action +
                       (this.nativeFeeMandatory()
                        ? ' (no fee quote is available for it on ' + this.config['COIN'] + ')'
                        : ' (pay the fee in XCHAIN)') });

        let blockIndex = await this.indexerDb.getLatestBlockIndex();
        let blockTime  = await this.indexerDb.getBlockTime(blockIndex);
        base.blockIndex = blockIndex;
        base.blockTime  = blockTime;

        // A schedule that cannot price the action (a key missing or mistyped) fails CLOSED, back
        // to the refusal: quoting a fee from a half-read schedule is how an output gets under-sized.
        let staticFee = await this.staticProtocolFee(action, params, blockIndex);
        if(staticFee === null)
            return Object.assign(base, { supported: false, valid: false, denied: true,
                error: 'native fee pre-flight not supported for ' + action });

        base.staticQuote = true;
        base.validated   = false;
        if(staticFee.error)
            return Object.assign(base, { valid: false, error: staticFee.error, xchainFee: null });

        base.gasCost = staticFee.gasCost;
        let quote = await this.priceFeeQuote(base, staticFee.xchainFee, feeOutputSats);
        if(quote.valid === true) quote.valid = null;
        quote.note = action + ' is priced from the gas schedule without a dry-run: the fee is the ' +
            'protocol fee the chain checks the native-coin output against, but on-chain validity ' +
            'is NOT pre-judged (the public pre-flight never runs caller-supplied VM code).';
        return quote;
    }

    // Read-only native-coin fee pre-flight (the public `feequote` JSON-RPC). Phase 2: runs the
    // REAL action handler in a forced-rollback dry-run (dryRunAction), so validity is
    // authoritative for any quotable action: class-A failures (fee sizing, oracle price) AND
    // class-B failures the Phase-1 estimator could never see (insufficient balance, taken
    // ticker, expired order, ...), surfaced verbatim in `error`/`status`. The fee is the
    // handler's own staged number, so there is no estimator to drift (estimateActionFee is
    // retired) and no supported-subset restriction. The VM/compound actions in
    // FEE_QUOTE_DENYLIST never reach the engine here; DEPLOY/EXECUTE instead get a
    // schedule-priced, verdict-free quote (FEE_QUOTE_STATIC / staticFeeQuote) and XEXEC/BATCH
    // stay unquotable. Never persists.
    //
    // Guardrails for a public endpoint: quotes serialize against the block loop on the db
    // transaction mutex, so each is time-boxed (INDEXER_FEEQUOTE_TIMEOUT_MS, default 10s,
    // instead of the 300s block watchdog) and admission-capped
    // (INDEXER_FEEQUOTE_MAX_PENDING, default 8; beyond it callers get a retryable busy error
    // rather than a queue that could starve block processing).
    // `feeOutputSats` (optional) is the proposed output value in satoshis.
    async computeFeeQuote({ action, params, source, feeOutputSats }){
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        ({ action, params } = normalizeQuoteRequest(this.actionAliases, action, params));
        let base = feeQuoteBase(this, action, feeDestination);

        // Native-coin fees are off unless a real FEE_DESTINATION is configured.
        if(!feeDestination || feeDestination === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
            return Object.assign(base, { supported: false, valid: false, error: 'native coin fee not enabled (no FEE_DESTINATION configured)' });

        // Single classification path (classifyFeeQuoteAction) shared with the conformance test;
        // it re-applies the same trim/uppercase/de-alias normalization (idempotent on the already
        // normalized `action` above) and preserves deny-before-exempt ordering.
        let feeClass = classifyFeeQuoteAction(action);
        if(feeClass === 'denied')
            return await this.staticFeeQuote(base, action, params, feeOutputSats);
        if(feeClass === 'exempt')
            return exemptFeeQuote(base, action);

        let maxPending = parseInt(CONFIG_ENV.INDEXER_FEEQUOTE_MAX_PENDING, 10) || 8;
        if((this._feeQuotePending || 0) >= maxPending)
            return Object.assign(base, { valid: false, busy: true, retryable: true,
                error: 'fee quote busy (' + maxPending + ' quotes already pending); retry shortly' });

        let timeoutMs = parseInt(CONFIG_ENV.INDEXER_FEEQUOTE_TIMEOUT_MS, 10) || 10000;
        let acquireMs = feeQuoteAcquireBudgetMs();
        this._feeQuotePending = (this._feeQuotePending || 0) + 1;
        let run;
        try {
            run = await this.dryRunAction({
                action, params, source,
                probeFeeDestination: feeDestination,
                timeoutMs: timeoutMs,
                acquireTimeoutMs: acquireMs,
                label: 'feequote ' + action,
                // Public unauthenticated path: a controller guard must never enter the VM
                // here (see invokeController). feequotedryrun deliberately omits this.
                guardInert: true,
                // No transaction exists yet, so output-matching fee checks are unanswerable.
                feeProbe: true
            });
        } catch(e){
            // Block processing still holds the transaction mutex. The admission cap
            // above cannot see this: it counts pending QUOTES, so a single quote arriving
            // during a slow block sailed past it and then waited out the whole block. Answer
            // the same retryable busy shape, in the budget rather than in block-time, so the
            // caller retries instead of reading a proxy timeout as an outage.
            if(isTxLockBusy(e))
                return feeQuoteLockBusy(base, acquireMs);
            throw e;
        } finally {
            this._feeQuotePending--;
        }
        base.blockIndex = run.blockIndex;
        base.blockTime  = run.blockTime;
        base.status     = run.status;
        base.validated  = true;

        return dryRunVerdictQuote(this, base, run, action) || await this.priceFeeQuote(base, run.xchainFee, feeOutputSats);
    }

    // Wire-string pre-scan for the BATCH pre-flight: the FIRST sub-command the probe path must
    // refuse to dispatch, or null when every sub-command is safe to run.
    //
    // Reproduces batch.js's own command split exactly - `TX_DATA.split(';')`, then strip the
    // `BATCH|<format>|` prefix off element 0, then take `split('|')[0]` - so the names scanned
    // here are the names that loop will dispatch. Two deliberate asymmetries, both in the
    // REFUSING direction: this trims and de-aliases unconditionally (batch.js only de-aliases
    // at/after BATCH_SUBACTION_NORMALIZATION), and an unrecognized FORMAT leaves the prefix
    // unstripped so element 0 reads as `BATCH`, which is itself forbidden. It can therefore
    // refuse a batch the loop would have found harmless, and never the reverse.
    //
    // This runs BEFORE the dry-run takes the block-loop mutex, so a batch carrying a VM
    // sub-action costs the node one string scan rather than a transaction. It is NOT the
    // load-bearing guard: batch.js re-checks each dispatched name (see
    // isBatchProbeForbiddenSubAction).
    batchProbeForbiddenSubAction(params){
        let format   = this.util.getFormatVersion(params[0]);
        let commands = ['BATCH'].concat(params).join('|').split(';');
        commands[0]  = commands[0].replace('BATCH|' + format + '|', '');
        for(let command of commands){
            let name = String(command).split('|')[0];
            if(isBatchProbeForbiddenSubAction(name))
                return String(name).trim().toUpperCase();
        }
        return null;
    }

    // Public validity-first pre-flight. Answers "would the indexer accept this action?"
    // decoupled from native-coin fee support: unlike computeFeeQuote (which returns
    // supported:false when no FEE_DESTINATION is configured, conflating "no fee config" with
    // "didn't run"), this reports supported:true whenever the handler actually ran, and its
    // verdict is the action's on-chain validity STATUS. Reuses the same forced-rollback dry-run
    // engine, the same admission cap + timeout, and guardInert:true (controller guards never
    // enter the VM on this unauthenticated surface). VM actions stay denylisted; settlement/
    // lifecycle actions stay feeExempt (no dry-runnable verdict). A block-height-keyed memo
    // (this._preflightMemo) collapses identical same-height re-runs. Echoes the dry-run's own
    // `xchainFee` but no PRICING fields: converting that to a native-coin output is
    // computeFeeQuote's job. Surfaced publicly via the explorer's /{COIN}/api/preflight
    // proxy. Never persists (the dry-run always rolls back).
    //
    // The fee settlement mode (probe output or XCHAIN balance debit) is chosen by
    // resolvePreflightFeeMode (actions_class/quote_answers.js), whose note says why the
    // verdict is only truthful when that mode matches the payer's real transaction.
    async computePreflight({ action, params, source, feeMode }){
        let coin           = this.config['COIN'];
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        let probeDest      = (feeDestination && feeDestination !== 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') ? feeDestination : null;
        let feeTick        = this.config['GAS'];
        let resolvedMode   = resolvePreflightFeeMode(this, feeMode, probeDest);
        // Normalize identically to computeFeeQuote / dispatch (trim, uppercase, de-alias).
        ({ action, params } = normalizeQuoteRequest(this.actionAliases, action, params));
        let base = { supported: true, action: action, coin: coin };

        // Same classification path as the fee-quote gate (deny-before-exempt).
        let feeClass = classifyFeeQuoteAction(action);
        let refusal  = preflightGateAnswer(this, base, action, params, feeClass);
        if(refusal) return refusal;

        // Verdict memo keyed on (action, params, source, blockIndex, feeMode). A new tip
        // changes the key; so does the settlement mode, whose verdicts genuinely differ.
        let blockIndex = await this.indexerDb.getLatestBlockIndex();
        let memoKey    = this._preflightMemo.key(action, params, source, blockIndex, resolvedMode);
        let cached     = this._preflightMemo.get(memoKey);
        if(cached) return Object.assign({}, cached, { cached: true });

        let maxPending = parseInt(CONFIG_ENV.INDEXER_FEEQUOTE_MAX_PENDING, 10) || 8;
        if((this._feeQuotePending || 0) >= maxPending)
            return Object.assign(base, { valid: null, busy: true, retryable: true,
                error: 'pre-flight busy (' + maxPending + ' dry-runs already pending); retry shortly' });

        let timeoutMs = parseInt(CONFIG_ENV.INDEXER_FEEQUOTE_TIMEOUT_MS, 10) || 10000;
        let acquireMs = feeQuoteAcquireBudgetMs();
        this._feeQuotePending = (this._feeQuotePending || 0) + 1;
        let run;
        try {
            run = await this.dryRunAction({
                action, params, source,
                probeFeeDestination: (resolvedMode === 'native') ? probeDest : null,
                timeoutMs: timeoutMs,
                acquireTimeoutMs: acquireMs,
                label: 'preflight ' + action,
                guardInert: true,
                // Same reason as computeFeeQuote, and it bites harder here: this surface
                // answers "would the network accept this?", and in xchain fee mode it
                // passes no probe output at all.
                feeProbe: true,
                feeBalanceTick: feeTick
            });
        } catch(e){
            // Same give-up as computeFeeQuote: block processing holds the mutex, so
            // answer busy-and-retryable in the budget rather than queueing behind the block.
            // Never memoized - a busy answer is the absence of a verdict, not a verdict.
            if(isTxLockBusy(e))
                return preflightLockBusy(base, acquireMs);
            throw e;
        } finally {
            this._feeQuotePending--;
        }

        let result = preflightResult(this, base, run, resolvedMode, feeTick);
        this._preflightMemo.set(memoKey, result);
        return result;
    }

}

// Mix the split-out method families into the prototype, the way db/index.js assembles
// Database: each is a plain object of methods written against `this`.
Object.assign(Actions.prototype, transactionMethods, addressPrePass, feePricingMethods, feeViewMethods);

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

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
 * XChain Indexer - Actions class: the dry-run engine and the public read-only quote surfaces
 *
 * dryRunAction, staticFeeQuote, computeFeeQuote, batchProbeForbiddenSubAction and
 * computePreflight, mixed into Actions.prototype by actions/index.js through
 * quoteSurfaceMethods. The fee-quote policy they apply (the deny, static and exempt sets and
 * the classifiers over them) stays in actions/index.js, where sibling guards read it, and
 * reaches these functions as the `policy` argument.
 *
 ********************************************************************/

// Pure parts of the dry-run engine and both public read-only surfaces, given the instance explicitly.
const dryRunSupport = require('./dry_run_support.js');
const quoteAnswers  = require('./quote_answers.js');
const { syntheticDryRunTx, sourceFeeBalanceOrNull, quietAbandonedRun, readDryRunVerdict, dryRunOutcome } = dryRunSupport;
const { normalizeQuoteRequest, feeQuoteBase, exemptFeeQuote, feeQuoteLockBusy, dryRunVerdictQuote } = quoteAnswers;
const { resolvePreflightFeeMode, preflightGateAnswer, preflightLockBusy, preflightResult } = quoteAnswers;

// How long a public read-only dry-run waits for the block-processing transaction mutex before
// giving up. The default is deliberately well under the explorer's own 5s hop cap,
// because the whole point is that the indexer's structured "busy, retryable" answer wins the
// race against the proxy's transport timeout: losing it is what turned a block-processing
// overlap into a bare 502 UPSTREAM_ERROR and a refused compose in the wallet. It is also
// comfortably above a healthy block's processing time, so on a healthy venue nothing changes.
// Raising it past the hop cap re-creates the 502 it removes.
function feeQuoteAcquireBudgetMs(CONFIG_ENV){
    return parseInt(CONFIG_ENV.INDEXER_FEEQUOTE_ACQUIRE_TIMEOUT_MS, 10) || 2000;
}

// True for the give-up thrown by a bounded transaction-mutex acquire (db.acquireTxLock).
function isTxLockBusy(e){
    return !!(e && e.code === 'TX_LOCK_BUSY');
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
async function dryRunAction({ action, params, source, feeOutputs, probeFeeDestination, timeoutMs, acquireTimeoutMs, label, guardInert, feeProbe, feeBalanceTick }){
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
async function staticFeeQuote(policy, base, action, params, feeOutputSats){
    if(!policy.FEE_QUOTE_STATIC.has(action))
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
async function computeFeeQuote(policy, { action, params, source, feeOutputSats }){
    let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
    ({ action, params } = normalizeQuoteRequest(this.actionAliases, action, params));
    let base = feeQuoteBase(this, action, feeDestination);

    // Native-coin fees are off unless a real FEE_DESTINATION is configured.
    if(!feeDestination || feeDestination === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
        return Object.assign(base, { supported: false, valid: false, error: 'native coin fee not enabled (no FEE_DESTINATION configured)' });

    // Single classification path (classifyFeeQuoteAction) shared with the conformance test;
    // it re-applies the same trim/uppercase/de-alias normalization (idempotent on the already
    // normalized `action` above) and preserves deny-before-exempt ordering.
    let feeClass = policy.classifyFeeQuoteAction(action);
    if(feeClass === 'denied')
        return await this.staticFeeQuote(base, action, params, feeOutputSats);
    if(feeClass === 'exempt')
        return exemptFeeQuote(base, action);

    let maxPending = parseInt(policy.CONFIG_ENV.INDEXER_FEEQUOTE_MAX_PENDING, 10) || 8;
    if((this._feeQuotePending || 0) >= maxPending)
        return Object.assign(base, { valid: false, busy: true, retryable: true,
            error: 'fee quote busy (' + maxPending + ' quotes already pending); retry shortly' });

    let timeoutMs = parseInt(policy.CONFIG_ENV.INDEXER_FEEQUOTE_TIMEOUT_MS, 10) || 10000;
    let acquireMs = feeQuoteAcquireBudgetMs(policy.CONFIG_ENV);
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
function batchProbeForbiddenSubAction(policy, params){
    let format   = this.util.getFormatVersion(params[0]);
    let commands = ['BATCH'].concat(params).join('|').split(';');
    commands[0]  = commands[0].replace('BATCH|' + format + '|', '');
    for(let command of commands){
        let name = String(command).split('|')[0];
        if(policy.isBatchProbeForbiddenSubAction(name))
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
async function computePreflight(policy, { action, params, source, feeMode }){
    let coin           = this.config['COIN'];
    let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
    let probeDest      = (feeDestination && feeDestination !== 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') ? feeDestination : null;
    let feeTick        = this.config['GAS'];
    let resolvedMode   = resolvePreflightFeeMode(this, feeMode, probeDest);
    // Normalize identically to computeFeeQuote / dispatch (trim, uppercase, de-alias).
    ({ action, params } = normalizeQuoteRequest(this.actionAliases, action, params));
    let base = { supported: true, action: action, coin: coin };

    // Same classification path as the fee-quote gate (deny-before-exempt).
    let feeClass = policy.classifyFeeQuoteAction(action);
    let refusal  = preflightGateAnswer(this, base, action, params, feeClass);
    if(refusal) return refusal;

    // Verdict memo keyed on (action, params, source, blockIndex, feeMode). A new tip
    // changes the key; so does the settlement mode, whose verdicts genuinely differ.
    let blockIndex = await this.indexerDb.getLatestBlockIndex();
    let memoKey    = this._preflightMemo.key(action, params, source, blockIndex, resolvedMode);
    let cached     = this._preflightMemo.get(memoKey);
    if(cached) return Object.assign({}, cached, { cached: true });

    let maxPending = parseInt(policy.CONFIG_ENV.INDEXER_FEEQUOTE_MAX_PENDING, 10) || 8;
    if((this._feeQuotePending || 0) >= maxPending)
        return Object.assign(base, { valid: null, busy: true, retryable: true,
            error: 'pre-flight busy (' + maxPending + ' dry-runs already pending); retry shortly' });

    let timeoutMs = parseInt(policy.CONFIG_ENV.INDEXER_FEEQUOTE_TIMEOUT_MS, 10) || 10000;
    let acquireMs = feeQuoteAcquireBudgetMs(policy.CONFIG_ENV);
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

// The methods as Actions.prototype installs them, each bound to the loader's `policy`:
// { classifyFeeQuoteAction, isBatchProbeForbiddenSubAction, FEE_QUOTE_STATIC, CONFIG_ENV }.
// actions/index.js hands it in rather than this file requiring it, because a part that
// required its own loader would receive it half-built, and because a suite that reloads the
// loader under a fresh config (test/helpers/fresh_config.js) then gets these methods on that
// same config instead of the one this cached module first saw.
function quoteSurfaceMethods(policy){
    return {
        dryRunAction,
        staticFeeQuote(base, action, params, feeOutputSats){
            return staticFeeQuote.call(this, policy, base, action, params, feeOutputSats);
        },
        computeFeeQuote(request){ return computeFeeQuote.call(this, policy, request); },
        batchProbeForbiddenSubAction(params){ return batchProbeForbiddenSubAction.call(this, policy, params); },
        computePreflight(request){ return computePreflight.call(this, policy, request); }
    };
}

module.exports = quoteSurfaceMethods;

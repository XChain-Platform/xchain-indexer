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
 * XChain Indexer - Actions class: public quote and pre-flight answers
 *
 * The request normalization, refusal answers and result shapes of the two public
 * read-only surfaces, Actions.computeFeeQuote and Actions.computePreflight. Those methods
 * stay in actions/index.js with their admission cap, their dry-run call and the
 * config-read budgets; everything here is a pure function of what they pass in, taking
 * the Actions instance explicitly so a test context that borrows the two methods works.
 *
 ********************************************************************/

// Normalize exactly as processTransaction will before dispatch: trim then uppercase,
// then resolve ACTION aliases. Otherwise a whitespace-padded or aliased name would
// classify differently here than at dispatch, letting a caller skip the denylist and
// still reach the real VM-compute pre-flight.
function normalizeQuoteRequest(aliases, action, params){
    action = String(action || '').trim().toUpperCase();
    for(var alias in aliases){
        if(action == alias)
            action = aliases[alias];
    }
    if(!Array.isArray(params)) params = String(params == null ? '' : params).split('|');
    params = params.map(v => String(v).trim());
    return { action, params };
}

// The fields every computeFeeQuote answer starts from.
function feeQuoteBase(actions, action, feeDestination){
    let toleranceMin = actions.util.bcnum(actions.config['FEE_TOLERANCE_MIN'] || '0.95');
    let toleranceMax = actions.util.bcnum(actions.config['FEE_TOLERANCE_MAX'] || '1.10');
    return {
        supported:      true,
        action:         action,
        coin:           actions.config['COIN'],
        feeDestination: feeDestination,
        toleranceMin:   actions.util.bcformat(toleranceMin, 8),
        toleranceMax:   actions.util.bcformat(toleranceMax, 8)
    };
}

// Fee-exempt settlement/lifecycle actions: no protocol fee to price, and their required
// native outputs can't be reproduced by the dry-run harness. Answer zero, skip the engine.
function exemptFeeQuote(base, action){
    return Object.assign(base, {
        valid:             true,
        feeExempt:         true,
        xchainFee:         '0.00000000',
        requiredFeeNative: '0.00000000',
        requiredFeeSats:   0,
        note:              action + ' carries no protocol fee (settlement/lifecycle action); no native fee output required'
    });
}

// The retryable busy quote for a transaction-mutex give-up (see computeFeeQuote's catch).
function feeQuoteLockBusy(base, acquireMs){
    return Object.assign(base, { valid: false, busy: true, retryable: true,
        retryAfterMs: acquireMs,
        error: 'fee quote busy (the indexer is processing a block; waited ' + acquireMs +
               'ms for the database transaction lock); retry shortly' });
}

// The quote a finished dry-run answers WITHOUT pricing, or null when the verdict is valid
// and the fee should be priced.
function dryRunVerdictQuote(actions, base, run, action){
    // A controlled token whose guard the feequote path refused (never entered the VM,
    // see invokeController): the native-fee verdict genuinely depends on a controller
    // guard we do not run on this public surface, so report it as not natively quotable
    // rather than surfacing the sentinel as a spurious class-B invalidity. The sentinel
    // carries WHICH controller declined, so quote that too: an action can consult several
    // guards (a SEND consults the token's, the sender's and the recipient's), and "something
    // here is controlled" is not an answer a wallet can act on.
    if(actions.util.isGuardInertError(run.status))
        return Object.assign(base, { supported: false, valid: false,
            guardInert: true,
            guardInertReason: actions.util.describeGuardInert(run.status),
            error: 'native fee pre-flight not supported for a controller-bound ' + action + ' ('
                 + actions.util.guardInertDetail(run.status) + '; pay the fee in XCHAIN)' });

    // The handler's verdict is authoritative; its reason (class-A or class-B) verbatim.
    if(run.status !== 'valid')
        return Object.assign(base, {
            valid:     false,
            error:     run.error || run.status || 'dry-run produced no status',
            xchainFee: (run.xchainFee == null) ? null : actions.util.bcformat(actions.util.bcnum(run.xchainFee), 8)
        });
    return null;
}

// FEE SETTLEMENT MODE. The verdict is only truthful if the dry-run settles the
// protocol fee the way the payer's real transaction will. computeFeeQuote always injects
// the probe fee output (it is pricing a NATIVE output, so native mode is the question it
// asks). Copying that unconditionally into pre-flight would silently exempt every
// quote from the XCHAIN balance debit and make "payer holds zero XCHAIN" invisible: the
// endpoint would answer valid, the wallet would sign, the miner fee would be spent, and
// the chain would index `invalid: insufficient funds (FEE)`. So the mode is chosen here:
//   - `feeMode: 'native'`  injects the probe output (fee settles from a coin output).
//   - `feeMode: 'xchain'`  injects nothing, so detectFeePaymentMode picks the XCHAIN
//                          balance debit and the handler checks the payer's balance.
//   - default: 'native' on a mandatory-native chain (LTC/DOGE, where no other mode
//     exists), 'xchain' everywhere else - which is the mode a BTC wallet composes by
//     default. A configured-but-unusable FEE_DESTINATION falls back to 'xchain'.
// The mode is part of the memo key, so the two answers can never be served for each other.
// Native-fee OUTPUT SIZING is still out of scope here: this surface prices
// nothing, and the SDK Tier-1 keeps native-fee-output aspects `unverified` regardless.
function resolvePreflightFeeMode(actions, feeMode, probeDest){
    let requestedMode  = String(feeMode == null ? '' : feeMode).trim().toLowerCase();
    let resolvedMode   = (requestedMode === 'native' || requestedMode === 'xchain')
                       ? requestedMode
                       : (actions.nativeFeeMandatory() ? 'native' : 'xchain');
    // Native settlement needs somewhere to pay: with no usable FEE_DESTINATION the chain
    // itself falls back to the XCHAIN debit (utility.detectFeePaymentMode), so match it.
    if(resolvedMode === 'native' && !probeDest) resolvedMode = 'xchain';
    return resolvedMode;
}

// The pre-flight refusal for an action this surface will not dry-run, or null to proceed.
function preflightGateAnswer(actions, base, action, params, feeClass){
    // BATCH gets a SUB-COMMAND-LEVEL pre-flight rather than the flat refusal, which is
    // the whole point: a wallet composing a batch could get no chain verdict at all, so
    // every batch-only rule (the per-payee COINPAY resolution, the cumulative fee ledger,
    // the command cap) was unreachable from a client and the SDK's Tier 1 fell through to
    // static checks. The safe door is per-sub-command refusal, NOT lifting BATCH out of
    // FEE_QUOTE_DENYLIST: the batch still cannot carry anything that reaches the VM, so
    // the unauthenticated compute primitive the denylist exists to close stays closed.
    //
    // computeFeeQuote deliberately still refuses BATCH. Its refusal has an INDEPENDENT
    // reason this does not answer (a batch's native fee is the SUM of its sub-actions'
    // state-dependent fees, and a partial quote UNDER-SIZES the output, which burns the
    // payer's miner fee on a guaranteed-invalid transaction). Validity and pricing are
    // separate questions and only the validity one is closed here.
    if(action === 'BATCH'){
        let forbidden = actions.batchProbeForbiddenSubAction(params);
        if(forbidden)
            return Object.assign(base, { supported: false, denied: true, valid: null,
                deniedSubAction: forbidden,
                error: 'BATCH is not available on the public pre-flight endpoint with a ' +
                       forbidden + ' sub-command (it would run caller-supplied code in the ' +
                       'VM; use the authenticated dry-run)' });
    } else if(feeClass === 'denied')
        return Object.assign(base, { supported: false, denied: true, valid: null,
            error: action + ' is not available on the public pre-flight endpoint (VM action; use the authenticated dry-run)' });
    if(feeClass === 'exempt')
        return Object.assign(base, { supported: false, feeExempt: true, valid: null,
            note: action + ' is a settlement/lifecycle action with no dry-runnable verdict' });
    return null;
}

// The retryable busy pre-flight for a transaction-mutex give-up (see computePreflight's catch).
function preflightLockBusy(base, acquireMs){
    return Object.assign(base, { valid: null, busy: true, retryable: true,
        retryAfterMs: acquireMs,
        error: 'pre-flight busy (the indexer is processing a block; waited ' + acquireMs +
               'ms for the database transaction lock); retry shortly' });
}

// The fee a pre-flight discloses beside its verdict, and the payer's balance against it.
function preflightFeeDisclosure(util, run, resolvedMode){
    // The dry-run already staged the handler's fee record, so echoing it costs nothing and
    // saves the caller a second round-trip to /feequote purely to disclose the fee.
    // `xchainFee` is the XCHAIN-denominated protocol fee in EVERY payment mode (the fee row
    // is always XCHAIN-denominated; native mode only changes how it is settled), which is
    // exactly what a confirm screen owes the user in the default XCHAIN mode. Sizing the
    // native-coin output stays computeFeeQuote's job: this surface never prices the fee, so
    // the probe output injected above cannot mislead. null when the run never staged a fee
    // (rejected before the handler recorded one); '0.00000000' for a valid zero-fee action.
    let xchainFee = (run.xchainFee == null) ? null : util.bcformat(util.bcnum(run.xchainFee), 8);

    // The payer's fee-token balance next to the fee it owes. Two callers need it:
    // a client that wants to say "you need N XCHAIN, you hold M" instead of relaying a bare
    // error string, and a native-mode caller, whose verdict above deliberately does NOT
    // depend on the XCHAIN balance but whose user may still want to see it. null when the
    // read was unavailable (no source, unknown fee tick), never a guessed zero.
    let feeTokenBalance = (run.sourceFeeBalance == null)
                        ? null : util.bcformat(util.bcnum(run.sourceFeeBalance), 8);
    // Only meaningful for the mode that settles from that balance; null (not false) in
    // native mode so nobody reads "cannot afford" into a fee that is not paid in XCHAIN.
    // Judged on the RAW values, not the 8dp display strings: a ledger balance carries more
    // precision than the display, and rounding it up to 8dp could call a fractionally
    // short payer affordable, which is exactly the false PASS this field exists to end.
    let feeAffordable = (resolvedMode !== 'xchain' || run.sourceFeeBalance == null || run.xchainFee == null)
                      ? null
                      : util.bcgte(util.bcnum(run.sourceFeeBalance), util.bcnum(run.xchainFee));
    return { xchainFee, feeTokenBalance, feeAffordable };
}

// The pre-flight answer for a finished dry-run (memoized by the caller).
function preflightResult(actions, base, run, resolvedMode, feeTick){
    // A controller-bound token whose guard the public path refused to run: the validity
    // verdict genuinely depends on a guard we do not enter here. Surface it as a boolean
    // so the client falls through to its authenticated/certified tier rather than trusting
    // a guard-less verdict.
    // The boolean says THAT the guard was skipped; guardInertReason says WHICH controller
    // skipped it, so a client can name the cause instead of relaying a bare sentinel.
    let guardInert = actions.util.isGuardInertError(run.status);
    let valid      = (run.status === 'valid');
    let fee        = preflightFeeDisclosure(actions.util, run, resolvedMode);

    let result = Object.assign(base, {
        valid:      guardInert ? null : valid,
        status:     run.status,
        error:      valid ? null : (run.error || run.status || 'dry-run produced no status'),
        guardInert: guardInert,
        guardInertReason: guardInert ? actions.util.describeGuardInert(run.status) : null,
        feeExempt:  false,
        xchainFee:  fee.xchainFee,
        feeMode:    resolvedMode,
        feeTick:    feeTick,
        feeTokenBalance: fee.feeTokenBalance,
        feeAffordable:   fee.feeAffordable,
        blockIndex: run.blockIndex,
        blockTime:  run.blockTime
    });

    // BATCH only. `subCommands` is each sub-command's own verdict in list order, which is
    // what a batch pre-flight actually owes a composer: sub-commands are NOT atomic, so
    // "the BATCH is valid" says nothing about which of them will settle.
    if(run.subCommands) result.subCommands = run.subCommands;

    // Oracle usage fees this batch owes, per oracle address, summed over its Mode B
    // DISPENSER sub-commands. DISCLOSED, not judged: a probe carries no transaction and
    // therefore no oracle fee outputs, so the handler's own check (util.validateOracleFee)
    // is unreachable here and dispenser.js answers from util.quoteOracleFee, which reads no
    // output at all. That answer is OPTIMISTIC by construction and stays optimistic per
    // sub-command - N DISPENSERs naming one oracle each quote the same single fee valid,
    // where the chain wants the output to cover all N. Rather than fake a verdict the probe
    // cannot compute, report the TOTAL owed per oracle so a composer can size the outputs.
    if(run.oracleFeesOwed) result.oracleFeesOwed = run.oracleFeesOwed;
    return result;
}

module.exports = {
    normalizeQuoteRequest,
    feeQuoteBase,
    exemptFeeQuote,
    feeQuoteLockBusy,
    dryRunVerdictQuote,
    resolvePreflightFeeMode,
    preflightGateAnswer,
    preflightLockBusy,
    preflightResult
};

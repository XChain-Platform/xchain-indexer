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
 * XChain Indexer - Utility: controller guards
 *
 * Routes a native action to its controller class and runs the token or address controller's
 * guard, including the guard-inert refusal the read-only fee quote paths return.
 *
 ********************************************************************/

'use strict';

// The status a handler records when a bound controller's guard cannot run: the read-only
// pre-flight surfaces (feequote / preflight, and a BATCH's per-sub-command verdicts) refuse to
// enter a controller VM, so the action is UNJUDGED rather than rejected. Matched as a substring
// everywhere, because a handler wraps it ('invalid: ' + error) and the refusal appends the
// controller detail after it. See Utility.guardInertError / isGuardInertError.
const GUARD_INERT_SENTINEL = 'FEE_QUOTE_CONTROLLER_UNSUPPORTED';

// The request runControllerGuard runs a controller's guard with: the action's own fields, each
// absent one passed as '' rather than null or undefined, the host transaction data, the next
// call depth and the emission sequence number. Built for invokeController, its only caller.
function controllerGuardRequest(util, controllerIndex, opts, data){
    return {
        actionType:      opts.actionType,
        controllerIndex: Number(controllerIndex),
        tick:            util.isNull(opts.tick)         ? '' : opts.tick,
        from:            util.isNull(opts.from)         ? '' : opts.from,
        to:              util.isNull(opts.to)           ? '' : opts.to,
        amount:          util.isNull(opts.amount)       ? '' : opts.amount,
        price:           util.isNull(opts.price)        ? '' : opts.price,
        proceedsTick:    util.isNull(opts.proceedsTick) ? '' : opts.proceedsTick,
        hostData:        data,
        callDepth:       (Number(data['CALL_DEPTH']) || 0) + 1,
        seq:             Number(opts.seq) || 0
    };
}

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    /*****************************************************************
     * Programmable policy layer: shared controller-guard enforcement.
     ****************************************************************/

    // Static map from a native action (in its guarded context) to the controlled action-class.
    // Deliberately NOT derived from data['ACTION'] dynamically, so a newly added action can never
    // silently fall into a controlled class. An unmapped action returns null (never gated).
    controllerActionClass(actionType){
        switch(actionType){
            // Every native OUTBOUND transfer of a controlled token routes through the `transfer`
            // class so a bound controller's rule (allowlist/freeze/compliance) is unavoidable. SEND
            // is the direct 1:1 transfer; AIRDROP/DIVIDEND/SWEEP are bulk moves gated on the
            // AGGREGATE outbound move per controlled tick (one guard run: from=SOURCE, amount=total),
            // never per recipient (bounded VM work; a controller needing per-recipient control denies
            // the aggregate).
            case 'SEND':
            case 'AIRDROP':
            case 'DIVIDEND':
            case 'SWEEP':            return 'transfer';
            // The deed-over of a token's OWNERSHIP record is a separate capability from moving its
            // balance, so it routes to its own `ownership` class (an issuer can make ownership
            // non-sweepable while balances stay freely transferable, or vice versa). SWEEP_OWNERSHIP is
            // synthetic: sweep.js emits it per swept ownership so the controller's guard runs on
            // from=SOURCE, to=DESTINATION for the deeded tick. No on-chain action decodes to it.
            case 'SWEEP_OWNERSHIP':  return 'ownership';
            case 'ORDER_CREATE':
            case 'SWAP_CREATE':
            case 'DISPENSER_CREATE': return 'trade';
            case 'DESTROY':          return 'burn';
            // Both are wired and gating today: mint.js runs the guard on supply creation, stake.js
            // on the v3 contract-targeted path only (v1/v2 capability stakes are never gated).
            case 'MINT':             return 'mint';
            case 'STAKE':            return 'stake';
            default:                 return null;
        }
    },

    // ─── guard-inert refusals (the public probe declining to enter a controller VM) ──────────
    //
    // One sentinel, three surfaces (feequote, preflight, and a BATCH's per-sub-command verdict),
    // so the recognizer and the message live here rather than being re-spelled at each of them.

    // Is this status/error string a guard-inert refusal rather than a real rejection?
    isGuardInertError(status){
        return (typeof status === 'string') && status.indexOf(GUARD_INERT_SENTINEL) !== -1;
    },

    // The refusal itself, naming the controller that caused it (contract index + what bound it).
    guardInertError(controllerIndex, binding){
        let detail = 'contract ' + Number(controllerIndex);
        if(binding && binding.actionClass) detail += ' controls ' + String(binding.actionClass);
        if(binding && binding.subject)     detail += ' for ' + String(binding.subject);
        return GUARD_INERT_SENTINEL + ' (' + detail + ')';
    },

    // Just the controller detail out of a guard-inert status string. The parenthetical is
    // OPTIONAL by design: a bare sentinel with no parenthetical (e.g. one relayed by an
    // older node) still yields a usable phrase rather than an empty parenthesis or a crash.
    guardInertDetail(status){
        if(!this.isGuardInertError(status)) return null;
        let m = String(status).match(new RegExp(GUARD_INERT_SENTINEL + '\\s*\\(([^)]*)\\)'));
        return (m && m[1].trim() !== '') ? m[1].trim() : 'controller not named by this node';
    },

    // The same refusal as a sentence a client can show. Returns null when `status` is not one.
    describeGuardInert(status){
        if(!this.isGuardInertError(status)) return null;
        return 'a bound controller (' + this.guardInertDetail(status) + ') gates this action, and '
             + 'the read-only pre-flight never enters a controller VM; use the authenticated '
             + 'dry-run for a verdict';
    },

    // Run the bound controller's `guard` for one native action when the token has an effective
    // controller for the routed action-class. Single enforcement point called at each token
    // handler's validated→settlement boundary (replaces the per-handler ad-hoc veto blocks).
    // Returns { error, guardFee, payoutLegs }:
    //   - error      : non-null = DENY (caller leaves status as 'invalid: '+error, writes no ledger)
    //   - guardFee   : GAS to debit from SOURCE when the action proceeds (metered guard gas)
    //   - payoutLegs : reserved for the at-create royalty/fee split (null here)
    // No controller, an unmapped class, or a self guard-of-guard emission → { null, 0, null }.
    async maybeRunControllerGuard(actions, db, opts){
        let none = { error: null, guardFee: 0, payoutLegs: null };
        let data = opts.data;
        let actionClass = this.controllerActionClass(opts.actionType);
        if(!actionClass) return none;
        // Resolve the token's effective controller for this class (append-only read-time cooldown).
        // Most-specific-wins: a class-specific binding overrides the catch-all 'all' binding.
        let tickId = await db.getTickerId(opts.tick);
        if(this.isNull(tickId)) return none;
        let effective = await db.getEffectiveTokenControllerForGuard(tickId, actionClass, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        if(!effective) return none;
        // Record that this tick's controller was consulted this action (PTLC completeness assertion).
        if(!data['_GUARDED_TICKS']) data['_GUARDED_TICKS'] = {};
        data['_GUARDED_TICKS'][String(opts.tick)] = true;
        return this.invokeController(actions, db, Number(effective.contract_index), opts,
            { actionClass: actionClass, subject: 'token ' + String(opts.tick) });
    },

    // Recipient/account-side enforcement: run the SUBJECT address's controller for the given class
    // (opts.address + opts.actionClass). The contract bound to that account gates the action; e.g.
    // an incoming direct SEND the recipient didn't solicit (spam/compliance); refusal reverts it.
    // Resolves by address (address_controllers); same gas-reservation + guard-of-guard semantics.
    async maybeRunAddressControllerGuard(actions, db, opts){
        let none = { error: null, guardFee: 0, payoutLegs: null };
        if(!opts.actionClass) return none;
        let addressId = await db.getAddressId(opts.address);
        if(this.isNull(addressId)) return none;
        // Most-specific-wins: a class-specific binding overrides the catch-all 'all' binding.
        let effective = await db.getEffectiveAddressControllerForGuard(addressId, opts.actionClass, opts.data['BLOCK_INDEX'], opts.data['ACTION_INDEX']);
        if(!effective) return none;
        return this.invokeController(actions, db, Number(effective.contract_index), opts,
            { actionClass: opts.actionClass, subject: 'address ' + String(opts.address) });
    },

    // Shared tail for both controller kinds: the guard-of-guard skip, the gas-ceiling reservation
    // against SOURCE, the VM guard run (fail-closed in runControllerGuard), and the fee derivation.
    // `binding` describes what bound the controller (class + subject) and is used ONLY to name the
    // cause in the guard-inert refusal below; it never influences enforcement.
    async invokeController(actions, db, controllerIndex, opts, binding){
        let data = opts.data;
        // Activation gate (single shared chokepoint for both token- and address-controller
        // guards). Until the CONTROLLER_GUARD flag-day the guard is a strict no-op on every
        // node: no allow/deny VM run, no payout_legs, no guard contract_executions row, so a
        // node that lacks the controller layer and one that has it settle every guarded action
        // identically. This one check atomically gates the whole surface: the VM allow/deny in
        // runControllerGuard, the payout_legs column write in order.js/swap.js, the match-time
        // applyProceedsSplit in order_match.js/swap_match.js (which read the stored, now always
        // null pre-activation, payout_legs), and the guard-emission contract_hash contribution.
        // Without it the first guarded action forks the ledger and the federation checkpoint
        // preimage between heterogeneous node versions. See protocol_changes.js.
        if(!(await actions.protocolChanges.isEnabled('CONTROLLER_GUARD', data['BLOCK_INDEX'])))
            return { error: null, guardFee: 0, payoutLegs: null };
        // Public feequote dry-runs must never enter the controller VM. computeFeeQuote runs the
        // REAL handler under a forced rollback while holding the block-loop tx mutex, so executing
        // a caller-influenced guard here would hand the unauthenticated `feequote` endpoint an
        // unmetered VM-compute primitive - the exact class FEE_QUOTE_DENYLIST blocks for
        // DEPLOY/EXECUTE. Refuse at this single shared chokepoint (covering both token- and
        // address-controller guards, all guarded action classes) ONLY when a guard would truly run:
        // the caller reaches invokeController only after an effective controller resolved, so
        // uncontrolled tokens never hit this line and stay fully quotable, and a new guarded action
        // inherits the refusal for free. GUARD_INERT is set only on computeFeeQuote's synthetic tx
        // (never a decoded block tx, never the API-key-gated feequotedryrun), so this branch is dead
        // on block processing and cannot skip a guard on a real transaction.
        //
        // The sentinel NAMES its cause. A caller that gets back a bare
        // FEE_QUOTE_CONTROLLER_UNSUPPORTED cannot tell which of an action's several possible
        // guards declined - a SEND consults up to three (the token's, the sender's, the
        // recipient's) - so a wallet could only say "something about this is controlled". The
        // detail is appended, never substituted, so every existing consumer (which matches the
        // sentinel as a SUBSTRING: actions.js, sdk preflight/tier1.js) is unaffected. Safe to
        // change freely: this branch is reachable only on the synthetic GUARD_INERT probe tx, so
        // the string never enters a decoded action's status and carries no consensus weight.
        if(data['GUARD_INERT'])
            return { error: this.guardInertError(controllerIndex, binding), guardFee: 0, payoutLegs: null };
        // No guard-of-guard, keyed on the CONTROLLER rather than on the subject: an emission from
        // this same controller is never re-guarded, INCLUDING when it moves a different token or
        // address the same controller also governs (one controller bound to two tokens sees its
        // guard run once). Only a subject resolving to a DIFFERENT controller re-enters a guard,
        // bounded by VM_MAX_CALL_DEPTH.
        if(data['IS_GUARD_EMISSION'] && Number(data['EMITTER']) === Number(controllerIndex))
            return { error: null, guardFee: 0, payoutLegs: null };
        // Reserve the guard gas ceiling against SOURCE's GAS balance (caller-pays-for-attempt) so a
        // cheap/denied guard can never drive GAS negative; the metered fee is billed by the caller.
        // isGuardGasReserved keys the reservation on the CHAIN, not on whether an XCHAIN row
        // happens to exist here, so the bridge creating that row off BTC moves no verdict.
        let guardCeiling = this.resolveGuardGasCeiling(db.config);
        let maxGuardFee  = this.bcmul(guardCeiling, db.config['GAS_PRICE'], 8);
        if(this.isGuardGasReserved(data) && opts.gasInfo && this.bcgt(maxGuardFee, 0) && !this.hasBalance(opts.gasBalances, opts.gasInfo['TICK_ID'], maxGuardFee))
            return { error: 'insufficient funds (guard gas)', guardFee: 0, payoutLegs: null };
        let guard = await actions.actionExecute.runControllerGuard(controllerGuardRequest(this, controllerIndex, opts, data));
        if(!guard.allow)
            return { error: guard.reason, guardFee: 0, payoutLegs: null };
        return { error: null, guardFee: this.bcmul(guard.gasBilled, db.config['GAS_PRICE'], 8), payoutLegs: guard.payoutLegs || null };
    }
};

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
 * ISSUE token-bridge rules: the issuer's opt-in (format 7) and the milestone-1 policy
 * mutual exclusion in both directions, all inside TOKEN_BRIDGE_ACTIVATION.
 *
 * Each function runs with `this` bound to the Issue handler (./index.js calls the
 * outer one as fn.call(this, ctx)) and reads and writes the shared context.
 *
 ********************************************************************/

'use strict';

// Ceiling on the membership of a list a bridged token may carry. Not a hash input:
// enforced here and by the hub's refusal to sign a larger snapshot.
const { XPOLICY_MAX_MEMBERS } = require('../../protocol/constants.js');

// ── Token bridge: the issuer's opt-in (format 7) and the milestone-1 policy
//    mutual exclusion in both directions ─────────────────────────────────────────
//
// Everything in here is inside TOKEN_BRIDGE_ACTIVATION: neither the format-7 fields
// nor the `bridged` bit can exist below it, so below the flag not one verdict in
// this block can fire and a from-genesis replay is byte-identical.
//
// The LIST half of the exclusion lifts at TOKEN_POLICY_INHERITANCE_ACTIVATION, when
// a signed per-token policy snapshot carries the origin's lists to every bridged
// copy. The CONTROLLER half never lifts here: a binding
// names a contract deployed in THIS chain's VM, and no snapshot can carry a contract
// to another chain, so a controller-bound token stays unbridgeable and a bridged
// token stays unbindable until a controller-portability milestone.
async function validateBridgeRules(ctx){
    if(!ctx.error && ctx.tokenBridgeActive){
        validateOptInTick.call(this, ctx);
        validateBridgeFieldValues.call(this, ctx);

        // Is the row opted in to bridging after this action? '-' clears; empty inherits.
        let bridgeChainsSet = !this.util.isNull(ctx.data['BRIDGE_CHAINS']) && String(ctx.data['BRIDGE_CHAINS']) !== '-';

        await validateOptInDirection.call(this, ctx, bridgeChainsSet);
        validatePolicyDirection.call(this, ctx, bridgeChainsSet);
    }
}

// Format 7 needs an existing, undotted row to opt in.
function validateOptInTick(ctx){
    let { data, tokenInfo, format } = ctx;
    let error = ctx.error;

    // Format 7 edits an existing row and carries no creation fields, so without this
    // an ISSUE|7 naming an unknown tick would reach createToken and register the
    // name for nothing. Same branch shape and same verdict as format 6 above.
    if(!error && format === 7 && !tokenInfo)
        error = 'invalid: TICK (unknown)';

    // SUBASSETS ARE NOT BRIDGEABLE YET.
    //
    // The bridged row lives under its origin chain's root, so BTC.PEPECASH on DOGE is
    // a child of the root row BTC that the bridge creates itself. A DOTTED native name
    // would need a rooted copy of its own parent - BTC.PEPE.CASH needs BTC.PEPE - and
    // the bridge creates exactly one level, so the in-leg would strand on the parent
    // gate ('invalid: TICK (parent unknown)') AFTER the origin escrow had already been
    // debited. Refusing the OPT-IN, not just the lock, is what stops such a token from
    // ever being advertised as bridgeable: the v3 refusal (xbridge.js, same verdict
    // string) is the second line, not the first. A later flag day that walks the name
    // prefix can lift both.
    //
    // THE REFUSAL IS ON THE WHOLE FORMAT, not only on a non-empty BRIDGE_CHAINS: a
    // dotted row can never carry a value in these fields (every path that would set
    // one ends here), so a clear or a lock on one is meaningless, and refusing the
    // format outright leaves no shape of format 7 that a subasset answers to.
    //
    // THE RESOLVED NAME IS JUDGED, not the wire field. TICK also accepts the compact
    // ^<id> reference, which getTokenInfo resolves through getTickerId to the real row
    // (db.js createTicker), so testing data['TICK'] alone would let ^12 opt a subasset
    // in while the spelled-out name was refused. tokenInfo is always present here (the
    // unknown-tick refusal above ran first); the wire field is the fallback only so the
    // guard cannot depend on that ordering.
    let optInTick = String((tokenInfo && tokenInfo['TICK']) ? tokenInfo['TICK'] : data['TICK']);
    if(!error && format === 7 && optInTick.indexOf('.') !== -1)
        error = 'invalid: TICK (subassets are not bridgeable yet)';

    ctx.error = error;
}

// The format-7 field values: BRIDGE_CHAINS, MIN_DEPTH, and neither edited once
// LOCK_BRIDGE is set.
function validateBridgeFieldValues(ctx){
    let { issue, tokenInfo, format } = ctx;
    let error = ctx.error;

    // BRIDGE_CHAINS is a comma list of destination coins other than this chain, or
    // the sentinel '-' for none. EMPTY MEANS UNCHANGED, the rule every ISSUE field
    // follows through the populate-empty-params merge above, which is exactly why
    // "none" needs a sentinel and cannot be spelled as an empty field.
    if(!error && format === 7 && !this.util.isNull(issue['BRIDGE_CHAINS']) && String(issue['BRIDGE_CHAINS']) !== '-'){
        for(let chain of String(issue['BRIDGE_CHAINS']).split(',')){
            let c = String(chain).toUpperCase();
            if(!error && (this.config['COINS'].indexOf(c) === -1 || c === String(this.config['COIN']).toUpperCase()))
                error = 'invalid: BRIDGE_CHAINS';
        }
    }

    // MIN_DEPTH is a raise-only confirmation depth: the federation applies
    // max(platform default, MIN_DEPTH), so 0 means no raise. Digits only, the
    // COOLDOWN_BLOCKS shape above.
    if(!error && format === 7 && !this.util.isNull(issue['MIN_DEPTH']) && !/^\d+$/.test(String(issue['MIN_DEPTH'])))
        error = 'invalid: MIN_DEPTH (format)';

    // LOCK_BRIDGE=1 freezes both fields forever. The 0/1 format check and the
    // cannot-unset rule come free from fieldList['LOCK'] above; what does NOT come
    // free is refusing a later EDIT of the frozen fields, the same explicit guard
    // MAX_SUPPLY, MAX_MINT, DESCRIPTION and the CALLBACK fields each carry. This is
    // the holder's assurance against the owner, and against a new owner after a
    // format 0 TRANSFER, which inherits both fields.
    if(!error && format === 7 && tokenInfo && tokenInfo['LOCK_BRIDGE']==1 &&
       !this.util.isNull(issue['BRIDGE_CHAINS']) && String(issue['BRIDGE_CHAINS']) != String(tokenInfo['BRIDGE_CHAINS']))
        error = 'invalid: BRIDGE_CHAINS (locked)';

    // Verify MIN_DEPTH cannot be changed once LOCK_BRIDGE is set (mirrors the BRIDGE_CHAINS lock above)
    if(!error && format === 7 && tokenInfo && tokenInfo['LOCK_BRIDGE']==1 &&
       !this.util.isNull(issue['MIN_DEPTH']) && String(issue['MIN_DEPTH']) != String(tokenInfo['MIN_DEPTH']))
        error = 'invalid: MIN_DEPTH (locked)';

    ctx.error = error;
}

// OPT-IN DIRECTION. A token whose policy lives in chain-local state cannot be
// bridged while nothing carries that policy to the copy: a regulated issuer's
// block on BTC has to hold on DOGE. A list can never be cleared (format 5
// back-fills), so a token that has ever set one stays unbridgeable until
// policy inheritance arms.
async function validateOptInDirection(ctx, bridgeChainsSet){
    let { data, tokenInfo, format, policyInheritance } = ctx;
    let error = ctx.error;

    if(!error && format === 7 && bridgeChainsSet && tokenInfo){
        let hasAllow    = !this.util.isNull(tokenInfo['ALLOW_LIST']);
        let hasBlock    = !this.util.isNull(tokenInfo['BLOCK_LIST']);
        let controllers = await this.indexerDb.getTokenControllers(tokenInfo['TICK_ID'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        if(controllers && controllers.size > 0)
            error = 'invalid: TICK (policy-bound tokens are not bridgeable yet)';
        else if(!policyInheritance && (hasAllow || hasBlock))
            error = 'invalid: TICK (policy-bound tokens are not bridgeable yet)';
        else if(policyInheritance){
            // LIST CEILING. Every snapshot carries the FULL membership as transport and
            // every destination rewrites it into list_items on apply, so the origin's
            // list length is write amplification on every chain holding a copy. Not a
            // hash input anywhere: enforced here and by the hub's refusal to sign a
            // larger snapshot, so a later flag day can raise it.
            for(let listIndex of [tokenInfo['ALLOW_LIST'], tokenInfo['BLOCK_LIST']]){
                if(error || this.util.isNull(listIndex))
                    continue;
                let members = await this.indexerDb.getList(listIndex, data['BLOCK_INDEX']);
                if(members && members.length > XPOLICY_MAX_MEMBERS)
                    error = 'invalid: TICK (policy list exceeds XPOLICY_MAX_MEMBERS)';
            }
        }
    }

    ctx.error = error;
}

// POLICY DIRECTION. The mirror of the rule above: a token that is bridgeable or
// already bridged cannot take on a policy the copies do not carry. The `bridged`
// bit is set by the first applied v3 lock and no current rule clears it,
// so emptying BRIDGE_CHAINS after bridging does not reopen the door while copies
// are outstanding. Format 0's list fields are read off the WIRE snapshot, not
// the merged data, because the merge back-fills the row's own list indexes into
// every re-issue and would otherwise refuse an ordinary format 0 that carries no
// list at all.
function validatePolicyDirection(ctx, bridgeChainsSet){
    let { issue, tokenInfo, format, policyInheritance } = ctx;
    let error = ctx.error;

    let bridgedOut  = !!(tokenInfo && Number(tokenInfo['BRIDGED']) === 1);
    let carriesList = !this.util.isNull(issue['ALLOW_LIST']) || !this.util.isNull(issue['BLOCK_LIST']);
    if(!error && tokenInfo && (bridgeChainsSet || bridgedOut) &&
       (format === 6 || (!policyInheritance && (format === 5 || (format === 0 && carriesList)))))
        error = 'invalid: TICK (bridged tokens cannot be policy-bound yet)';

    ctx.error = error;
}

module.exports = { validateBridgeRules };

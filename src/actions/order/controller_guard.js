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
 * ORDER listing guard: a controller-bound GIVE token's `trade` controller
 * must approve the listing before the order opens, a royalty-bearing
 * cross-chain listing must be enforceable on the proceeds chain, and the
 * guard's payout legs are persisted on the order row.
 *
 ********************************************************************/

// The cross-chain royalty verdict for a guard that returned payout legs, or null when the
// listing may stand.
async function crossChainRoyaltyError(handler, data, payoutLegs){
    // Cross-chain royalty gate: the legs are computed on THIS chain but the proceeds
    // settle on GET_COIN, where only a CROSS_CHAIN_ROYALTY-aware fleet can apply them
    // (the legs ride the validator-signed match canonical). Below the flag-day, DENY
    // the listing (fail-closed: accepting it would silently evade the royalty). At or
    // above it, require every leg address to re-encode to GET_COIN so the settlement-
    // time re-encode can never hit an unpayable leg on a trade that already delivered.
    if(!(await handler.actions.protocolChanges.isEnabled('CROSS_CHAIN_ROYALTY', data['BLOCK_INDEX'])))
        return 'invalid: royalty not enforceable cross-chain';
    for(let leg of payoutLegs){
        if(!handler.util.canReencodeAddress(leg.to, handler.config['COIN'], data['GET_COIN'], handler.config['NETWORK']))
            return 'invalid: royalty leg not payable on proceeds chain';
    }
    return null;
}

// Run the GIVE token's controller guard for the listing and record the gas it reserves.
async function runListingGuard(handler, st){
    let { format, data, isNativeCoinGive, isOwnershipGive, isCrossChain, giveTokenInfo, balances, order } = st;
    let error = st.error;

    // Controller-bound GIVE token: the token's `trade` controller must approve LISTING this
    // token for sale before the order opens (the "list for sale" gate). Veto-only at create
    // (no proceeds yet); the royalty cut is taken at match time (order_match.js). Runs for both
    // amount and ownership listings of a real local token; SOURCE pays the bounded guard gas.
    let guardFee = 0;
    // Run the GIVE token's controller guard before allowing this token to be listed for sale
    if(!error && format==0 && !isNativeCoinGive && giveTokenInfo){
        let gasInfo = await handler.indexerDb.getTokenInfo(handler.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let result  = await handler.util.maybeRunControllerGuard(handler.actions, handler.indexerDb, {
            actionType:   'ORDER_CREATE',
            tick:         data['GIVE_TICK'],
            from:         data['SOURCE'],
            to:           '',
            amount:       isOwnershipGive ? '' : data['GIVE_AMOUNT'],
            price:        data['GET_AMOUNT'],
            proceedsTick: data['GET_TICK'],
            data:         data,
            gasInfo:      gasInfo,
            gasBalances:  balances
        });
        if(result.error){
            error = 'invalid: ' + result.error;
        } else {
            guardFee = result.guardFee;
            // Deny a royalty-bearing cross-chain listing the proceeds chain cannot honour
            if(result.payoutLegs && isCrossChain){
                let denial = await crossChainRoyaltyError(handler, data, result.payoutLegs);
                if(denial)
                    error = denial;
            }
            // Persist the guard's royalty/fee split (bps legs) on the order row; the protocol
            // applies it to the seller's proceeds at each match (Utility.applyProceedsSplit).
            // NB: `order` was snapshotted (Object.assign) before the guard ran, and createOrder
            // persists `order`, so set the legs on BOTH or they never reach the DB.
            if(!error && result.payoutLegs)
                data['PAYOUT_LEGS'] = order['PAYOUT_LEGS'] = JSON.stringify(result.payoutLegs);
        }
    }

    st.error    = error;
    st.guardFee = guardFee;
}

module.exports = { runListingGuard };

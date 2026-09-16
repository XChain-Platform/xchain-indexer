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
 * SWAP listing guard: a controller-bound GIVE token's bound contract must
 * approve the listing before the swap opens, a royalty-bearing
 * cross-chain listing must be enforceable on the proceeds chain, and the
 * guard's payout legs are persisted on the swap row.
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
    let { format, data, isOwnershipGive, isCrossChain, giveTokenInfo, balances, swap } = st;
    let error = st.error;

    // Controller-bound GIVE token: the bound contract's `guard` must approve
    // LISTING this token for sale before the swap opens. Veto-only at create
    // (no proceeds yet); the royalty cut is taken at match (swap_match.js).
    // SOURCE pays the bounded guard gas (reserved up front).
    let guardFee = 0;
    // Run the GIVE token's controller guard before allowing this token to be listed for sale
    if(!error && format==0 && giveTokenInfo){
        let gasInfo = await handler.indexerDb.getTokenInfo(handler.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let result  = await handler.util.maybeRunControllerGuard(handler.actions, handler.indexerDb, {
            actionType:   'SWAP_CREATE',
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
            // Persist the guard's royalty/fee split (bps legs) on the swap row; the protocol
            // applies it to the seller's proceeds at match (Utility.applyProceedsSplit).
            // NB: `swap` was snapshotted (Object.assign) before the guard ran, and createSwap
            // persists `swap`, so set the legs on BOTH or they never reach the DB.
            if(!error && result.payoutLegs)
                data['PAYOUT_LEGS'] = swap['PAYOUT_LEGS'] = JSON.stringify(result.payoutLegs);
        }
    }

    st.error    = error;
    st.guardFee = guardFee;
}

module.exports = { runListingGuard };

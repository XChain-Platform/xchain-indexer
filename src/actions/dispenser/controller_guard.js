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
 * DISPENSER handler part: the CONTROLLER GUARD.
 *
 * The bound contract veto on opening a dispenser that sells a controller-bound
 * token, and the guard gas it reserves. Moved whole out of parse(), comments and
 * the KNOWN GAP note included.
 *
 ********************************************************************/

'use strict';

// Installed onto Dispenser.prototype by dispenser.js; each method runs with `this`
// bound to the handler, exactly as the inline code it was.
module.exports = {

    // Sets ctx.guardFee, which settlement bills to SOURCE in GAS.
    async runControllerGuard(ctx){
    let { data, error, format, isOwnershipGive, giveTokenInfo, balances } = ctx;

        // Controller-bound GIVE token: the bound contract's `guard` must approve
        // opening a dispenser that sells this token before it opens. This guard is
        // VETO-ONLY at create: only result.error and result.guardFee are consumed
        // below; the guard's payoutLegs are intentionally discarded here.
        // SOURCE pays the bounded guard gas (reserved up front).
        //
        // KNOWN GAP: unlike ORDER and SWAP sales of a controller-bound token
        // (which persist payout_legs at create and apply the royalty split at match
        // time via applyProceedsSplit), DISPENSER sales apply NO royalty/proceeds
        // split. dispense.js has no royalty path: it credits the give token to the
        // buyer directly, and dispense proceeds are native coin paid directly
        // on-chain. So a controller cannot veto or take a cut per buy at dispense
        // time. TODO: if dispenser sales must honor the royalty split, that needs
        // dedicated design for a per-buy split/veto over native-coin proceeds; it is
        // NOT implemented today. Do not read this comment as an enforced invariant.
        let guardFee = 0;
        if(!error && format==0 && giveTokenInfo){
            let gasInfo = await this.indexerDb.getTokenInfo(this.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let result  = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                actionType:   'DISPENSER_CREATE',
                tick:         data['GIVE_TICK'],
                from:         data['SOURCE'],
                to:           '',
                amount:       isOwnershipGive ? '' : data['GIVE_ESCROW'],
                price:        data['GET_AMOUNT'],
                proceedsTick: data['GET_TICK'],
                data:         data,
                gasInfo:      gasInfo,
                gasBalances:  balances
            });
            if(result.error)
                error = 'invalid: ' + result.error;
            else
                guardFee = result.guardFee;
        }

    ctx.data = data;
    ctx.error = error;
    ctx.guardFee = guardFee;
    },
};


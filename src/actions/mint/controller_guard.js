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
 * MINT controller guard: the one step between validation and settlement where a token
 * bound to a controller contract may deny the mint or run its side effects.
 *
 * Runs with `this` bound to the Mint handler (./index.js calls it as fn.call(this, ctx)).
 *
 ********************************************************************/

'use strict';

// Run the token's `mint`-class (or catch-all `all`) controller guard, when one is bound.
// Sets ctx.error on a denial, and otherwise ctx.guardFee to the gas the guard spent.
async function runControllerGuard(ctx){
    let { data, tokenInfo } = ctx;
    let error = ctx.error;

    // Controller-bound token: a `mint`-class controller (or the catch-all `all`) may gate supply
    // creation: deny it or run programmable side-effects. After all MINT validation, before
    // settlement. SOURCE pays the bounded guard gas, billed as a GAS debit in the valid block
    // below (updateTokens there recomputes GAS supply, so the per-block sanityCheck stays balanced).
    let guardFee = 0;
    // Run the token's controller guard, if bound, before the mint settles
    if(!error && tokenInfo){
        let gasTick     = this.config['GAS'];
        let gasInfo     = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let gasBalances = await this.indexerDb.getAddressBalances(data['SOURCE'], gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
            actionType:  'MINT',
            tick:        data['TICK'],
            from:        data['SOURCE'],
            to:          this.util.isNull(data['DESTINATION']) ? data['SOURCE'] : data['DESTINATION'],
            amount:      data['AMOUNT'],
            data:        data,
            gasInfo:     gasInfo,
            gasBalances: gasBalances
        });
        if(result.error)
            error = 'invalid: ' + result.error;
        else
            guardFee = result.guardFee;
    }

    ctx.error = error;
    ctx.guardFee = guardFee;
}

module.exports = { runControllerGuard };

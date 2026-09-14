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
 * DESTROY controller guard: the GAS context a controlled burn is billed against, and
 * the per-leg guard run that may deny a burn of a controller-bound token.
 *
 * Runs with `this` bound to the Destroy handler (./index.js calls each as
 * fn.call(this, ...)).
 *
 ********************************************************************/

'use strict';

// Controller-bound token gas context. A DESTROY of a token whose `burn` class is bound to a
// controller runs that contract's `guard` before the burn settles; the SOURCE pays the
// (bounded) guard gas. Load the SOURCE's GAS balance once so a multi-destroy debits it
// cumulatively across controlled legs (maybeRunControllerGuard reserves the ceiling).
// The returned object is shared by every leg: a valid controlled leg lowers its
// gasBalances (see ./settle.js) so the next leg's guard sees the spend.
async function loadGasContext(data){
    let gasTick     = this.config['GAS'];
    let gasInfo     = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    let gasBalances = await this.indexerDb.getAddressBalances(data['SOURCE'], gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    return { gasTick, gasInfo, gasBalances };
}

// Run the `burn`-class controller guard for one leg, when its token is bound. Returns
// the verdict after the guard and the gas it spent (0 for an uncontrolled token).
async function runLegGuard(destroy, tokenInfo, idx, gas, error){
    // Guard gas fee billed to SOURCE for this leg (0 = uncontrolled token)
    let guardFee = 0;

    // Controller-bound token: the token's `burn` controller must approve destroying it.
    if(!error && tokenInfo){
        let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
            actionType:  'DESTROY',
            tick:        destroy['TICK'],
            from:        destroy['SOURCE'],
            to:          '',
            amount:      destroy['AMOUNT'],
            data:        destroy,
            gasInfo:     gas.gasInfo,
            gasBalances: gas.gasBalances,
            seq:         parseInt(idx) || 0
        });
        if(result.error)
            error = 'invalid: ' + result.error;
        else
            guardFee = result.guardFee;
    }

    return { error, guardFee };
}

module.exports = { loadGasContext, runLegGuard };

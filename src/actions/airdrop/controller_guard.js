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
 * XChain Platform Action - AIRDROP: controller guard
 *
 * The bound controller's guard over one leg's aggregate outbound move.
 *
 ********************************************************************/

// Installed onto Airdrop.prototype by airdrop.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Run the controller guard once on the aggregate outbound move (from=SOURCE, amount=total
    // DEBIT), reserving its metered fee against `balances` before the per-tx fee check so a
    // GAS-short holder cannot over-debit GAS and trip the sanity check.
    //
    // Returns { error, guardFee, legBalances }, legBalances already reduced by any guard gas.
    async runAirdropGuard(idx, airdrop, tokenInfo, data, ctx, legBalances, error){
        // Guard gas fee billed to SOURCE for this leg (0 = uncontrolled token)
        let guardFee = 0;

        if(!error && tokenInfo){
            let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                actionType:  'AIRDROP',
                tick:        airdrop['TICK'],
                from:        data['SOURCE'],
                to:          '',
                amount:      airdrop['DEBIT'],
                data:        airdrop,
                gasInfo:     ctx.gasInfo,
                gasBalances: legBalances,
                seq:         parseInt(idx) || 0
            });
            if(result.error){
                error = 'invalid: ' + result.error;
            } else if(this.util.bcgt(result.guardFee, 0)){
                guardFee = result.guardFee;
                if(ctx.gasInfo)
                    legBalances = this.util.debitBalances(legBalances, ctx.gasInfo['TICK_ID'], guardFee);
            }
        }
        return { error, guardFee, legBalances };
    }
};

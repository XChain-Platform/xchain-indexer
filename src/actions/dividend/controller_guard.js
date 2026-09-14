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
 * XChain Platform Action - DIVIDEND: controller guard
 *
 * The bound controller's guard over the DIVIDEND's aggregate outbound
 * distribution.
 *
 ********************************************************************/

// Installed onto Dividend.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Controller-bound token: DIVIDEND_TICK's bound contract gates the AGGREGATE outbound
    // distribution once (from=SOURCE, amount=total DEBIT, no single recipient). Deny reverts the
    // whole dividend; an allow bills metered gas. Reserve the guard fee out of `balances` BEFORE
    // the per-tx fee check so a holder short on GAS can't pass the fee check and then be
    // over-debited by the guard fee (negative GAS -> sanityCheck halt). Flag-gated no-op pre-day.
    //
    // Returns { error, guardFee }; ctx.balances carries the reserved guard fee.
    async runDividendGuard(data, dividend, ctx, error){
        let guardFee = 0;
        if(!error && ctx.dividendTokenInfo){
            let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                actionType:  'DIVIDEND',
                tick:        data['DIVIDEND_TICK'],
                from:        data['SOURCE'],
                to:          '',
                amount:      dividend['DEBIT'],
                data:        data,
                gasInfo:     ctx.gasInfo,
                gasBalances: ctx.balances,
                seq:         0
            });
            if(result.error){
                error = 'invalid: ' + result.error;
            } else if(this.util.bcgt(result.guardFee, 0)){
                guardFee = result.guardFee;
                if(ctx.gasInfo)
                    ctx.balances = this.util.debitBalances(ctx.balances, ctx.gasInfo['TICK_ID'], guardFee);
            }
        }
        return { error, guardFee };
    }
};

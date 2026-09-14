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
 * XChain Platform Action - SEND: settle
 *
 * Records each leg with its final status, stages its ledger rows, and
 * closes the action once every leg has settled.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

// Installed onto Send.prototype by send.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Settle one leg: debit its AMOUNT, record its final status, and on a valid leg stage the
    // credit, the debit and any guard gas billed to SOURCE
    async settleSendLeg(send, tokenInfo, data, ctx, error, guard){
        let { guardFee, sameTick } = guard;

        // Adjust balances to reduce by SEND AMOUNT
        if(!error)
            ctx.balances = this.util.debitBalances(ctx.balances, tokenInfo['TICK_ID'], send['AMOUNT']);

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = send['STATUS'] = status;

        getLogger().info("\t SEND : " + send['TICK'] + ' : ' + this.util.logAmount(send['AMOUNT']) + ' : ' + send['DESTINATION'] + ' : '+ data['STATUS']);

        await this.indexerDb.createSend(send);

        this.util.addAddressTicker(data['SOURCE'], send['TICK']);

        // If this was a valid transaction, then add records to the credits and debits array
        if(status=='valid'){

            // Store the DESTINATION and TICK in addresses list
            this.util.addAddressTicker(send['DESTINATION'], send['TICK']);

            // Add ticker and amount to debits array
            ctx.debits.push([send['TICK'], send['AMOUNT'], send['SOURCE']]);

            // Add ticker, amount, and destination to credits array
            ctx.credits.push([send['TICK'], send['AMOUNT'], send['DESTINATION']]);

            // Bill the controller-guard gas to SOURCE (in GAS). Reduce the
            // in-memory GAS balance so a later controlled leg in this same
            // multi-send sees the spend when it re-checks its reservation.
            if(this.util.bcgt(guardFee, 0)){
                ctx.debits.push([ctx.gasTick, guardFee, send['SOURCE']]);
                this.util.addAddressTicker(send['SOURCE'], ctx.gasTick);
                if(ctx.gasInfo){
                    // When the sent tick IS the gas tick, debit the guard fee out of the same
                    // `balances` snapshot that AMOUNT was already debited from above, so
                    // AMOUNT + guardFee together are enforced against one balance. Otherwise
                    // (unchanged) debit the independent `gasBalances` snapshot.
                    if(sameTick)
                        ctx.balances = this.util.debitBalances(ctx.balances, ctx.gasInfo['TICK_ID'], guardFee);
                    else
                        ctx.gasBalances = this.util.debitBalances(ctx.gasBalances, ctx.gasInfo['TICK_ID'], guardFee);
                }
            }
        }
    },

    // Close the action once every leg has settled: apply the staged ledger rows, refresh the
    // touched balances and supplies, write the mappings and let the sends trigger dispensers
    async finishSend(data, ctx){
        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, ctx.credits, ctx.debits);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply. updateTokens is required because a
        // controller guardFee is burned as a GAS debit with no offsetting credit (above);
        // tokens.supply (GAS) must be recomputed from the ledger or the per-block sanityCheck
        // (ledger == supply == balances) trips and halts the indexer. Mirrors the other
        // guarded handlers (order.js/swap.js/dispenser.js) and execute.js.
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings
        await this.mapper.createMappings(data);

        // Check if any sends triggered dispensers
        await this.util.processDispenserSends(this.actions, this.indexerDb, data);
    }
};

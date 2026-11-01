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
 * XChain Platform Action - AIRDROP: settle
 *
 * Stages a leg's DEBIT on a cloned view, commits it once the leg is
 * valid, records the leg, and closes the action after the last leg.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
const gateRegistry = require('../../consensus/gate_registry');

const AIRDROP_ZERO_LEGS_OMITTED_KEY = 'airdrop_zero_legs_omitted_activation.AIRDROP_ZERO_LEGS_OMITTED_ACTIVATION';

// Installed onto Airdrop.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Require a balance that covers the leg's total DEBIT, then stage that debit on a cloned view
    // of the shared balances. Returns { error, legBalances }.
    stageAirdropLeg(airdrop, tokenInfo, ctx, error){
        // Verify SOURCE has enough balances to cover TICK total DEBIT amount
        if(!error && !this.util.hasBalance(ctx.balances, tokenInfo['TICK_ID'], airdrop['DEBIT']))
            error = 'invalid: insufficient funds (TICK)';

        // Stage this leg's debits on a cloned view; commit to shared `balances` only once the whole
        // leg validates. The clone must still carry the pending TICK debit so a same-leg check
        // sees it even when the airdropped tick is also the GAS/fee tick.
        let legBalances = (!error)
            ? this.util.debitBalances(Object.assign({}, ctx.balances), tokenInfo['TICK_ID'], airdrop['DEBIT'])
            : ctx.balances;
        return { error, legBalances };
    },

    // Take the fee out of the staged view, then commit that view as the shared balances when the
    // leg is valid
    commitAirdropLeg(fees, legBalances, ctx, error){
        // Adjust balances to reduce by FEE AMOUNT, only for XCHAIN deduction mode
        // (no PAYMENT_MODE, or mode 2)
        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            legBalances = this.util.debitBalances(legBalances, fees['TICK_ID'], fees['AMOUNT']);

        // Commit the staged view: only a fully-valid leg mutates the shared balances that the
        // next leg is measured against.
        if(!error)
            ctx.balances = legBalances;
    },

    // Record the leg with its final status and, on a valid leg, stage its DEBIT, any guard gas,
    // the fee and one credit per approved recipient
    async settleAirdropLeg(airdrop, data, ctx, error, recipients, guardFee){
        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = airdrop['STATUS'] = status;

        getLogger().info("\t AIRDROP : " + airdrop['TICK'] + ' : ' + this.util.logAmount(airdrop['AMOUNT']) + ' : '+ airdrop['STATUS']);

        await this.indexerDb.createAirdrop(airdrop);

        this.util.addAddressTicker(data['SOURCE'], airdrop['TICK']);

        // If we are charging a fee, store the SOURCE and fees TICK in addresses list
        if(this.util.bcgt(ctx.fees['AMOUNT'], 0))
            this.util.addAddressTicker(data['SOURCE'], ctx.fees['TICK']);

        // If this was a valid transaction, then add records to the credits and debits array
        if(status=='valid'){
            let omitZeroLegs = gateRegistry.activeAt(AIRDROP_ZERO_LEGS_OMITTED_KEY,
                this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null);
            // Add ticker, amount, and address to debits array
            if(!omitZeroLegs || this.util.bcgt(airdrop['DEBIT'], 0))
                ctx.debits.push([airdrop['TICK'], airdrop['DEBIT'], data['SOURCE']]);

            // Bill the controller-guard gas to SOURCE (a GAS burn with no offsetting credit). The
            // end-of-action updateTokens recomputes GAS supply from the ledger so the per-block
            // sanityCheck (ledger == supply == balances) holds. `balances` was already reduced above.
            if(this.util.bcgt(guardFee, 0)){
                ctx.debits.push([ctx.gasTick, guardFee, data['SOURCE']]);
                this.util.addAddressTicker(data['SOURCE'], ctx.gasTick);
            }

            // Handle any transaction FEE according the users's ADDRESS preferences
            [ctx.credits, ctx.debits] = await this.util.processTransactionFees(this.indexerDb, ctx.credits, ctx.debits, ctx.fees);
            this.addAirdropXchainFee(ctx);

            // Loop through recipient addresses
            for(let address of recipients){
                // Store the recipient ADDRESS and TICK in addresses list
                this.util.addAddressTicker(address, airdrop['TICK']);
                // Credit address with TICK AMOUNT
                if(!omitZeroLegs || this.util.bcgt(airdrop['AMOUNT'], 0))
                    ctx.credits.push([airdrop['TICK'], airdrop['AMOUNT'], address]);
            }
        }
    },

    // Sum a valid leg's XCHAIN-balance fee and gas (the native tally sums its own legs). Bookkeeping
    // only: each leg's debit is already staged from ctx.fees, which this never changes.
    addAirdropXchainFee(ctx){
        let fees = ctx.fees;
        if(ctx.nativeFeeTally || fees['PAYMENT_MODE'] !== 2 || !this.util.bcgt(fees['AMOUNT'], 0)) return;
        let total = ctx.xchainFeeTotal || (ctx.xchainFeeTotal = { amount: '0', gasCost: '0', legs: 0 });
        total.amount = this.util.bcadd(total.amount, fees['AMOUNT'], 8);
        total.gasCost = this.util.bcadd(total.gasCost, fees['GAS_COST'] || 0, 0);
        total.legs += 1;
    },

    // Rewrite the action's one fees row with the summed fee once two or more legs paid from the
    // XCHAIN balance, since each leg's own write keyed on action_index overwrites the one before
    async recordAirdropXchainFeeTotal(ctx){
        let total = ctx.xchainFeeTotal;
        if(!total || total.legs < 2) return;
        await this.indexerDb.createFeeRecord(Object.assign({}, ctx.fees, {
            AMOUNT: total.amount, GAS_COST: total.gasCost, XCHAIN_AMOUNT: total.amount
        }));
    },

    // Close the action once every leg has settled: apply the staged ledger rows, refresh the
    // touched balances and supplies, and write the mappings
    async finishAirdrop(data, ctx){
        await this.recordAirdropXchainFeeTotal(ctx);

        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, ctx.credits, ctx.debits);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
};

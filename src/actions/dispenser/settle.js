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
 * DISPENSER handler part: SETTLEMENT.
 *
 * The final status, the log line, the dispensers / dispenser_cancels /
 * dispenser_edits records (with the DISPENSER_CANCEL and DISPENSER_EDIT action
 * renames), and the ledger changes. This is also the file the escrow-attribution
 * guard reads: it pairs the escrows.push sites with the updateActionIndex renames
 * that name the actions those rows are written under, so the two must stay in one
 * file even though they are two methods.
 *
 ********************************************************************/

'use strict';

const divergenceMetrics = require('../../chain/dispenser_divergence_metrics.js');
const { getLogger } = require('../../observability/index.js');

// Installed onto Dispenser.prototype by index.js; each method runs with `this`
// bound to the handler, exactly as the inline code it was.
module.exports = {

    // Writes the action records, then the ledger effects. Runs whatever the verdict
    // is: an invalid attempt is still recorded, only the ledger half is skipped.
    async settleDispenser(ctx){
        await this.recordDispenserAction(ctx);
        await this.applyDispenserLedger(ctx);
    },

    // The final status, the log line, and the dispensers / dispenser_cancels /
    // dispenser_edits records, including the two action renames.
    async recordDispenserAction(ctx){
    let { data, error, format, dispenserInfo, dispenser } = ctx;

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = dispenser['STATUS'] = status;

        // Set DISPENSER status to 'open' when creating a valid dispenser
        dispenser['DISPENSER_STATUS'] = (status=='valid') ? 'open' : 'invalid';

        // Print status message
        if(format==0)
            getLogger().info("\t DISPENSER : " + this.util.logAmount(data['GIVE_AMOUNT']) + ' ' + this.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  this.util.logAmount(data['GET_AMOUNT']) + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);
        if(format==1)
            getLogger().info("\t DISPENSER_CANCEL : " + this.config['COIN'] + ':' + data['DISPENSER_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==2)
            getLogger().info("\t DISPENSER_EDIT : " + this.config['COIN'] + ':' + data['DISPENSER_ACTION_INDEX'] + ' : ' + data['STATUS']);
 
        // Create record in dispensers table
        if(format==0)
            await this.indexerDb.createDispenser(dispenser);

        // Update action from DISPENSER to DISPENSER_CANCEL and create record in dispenser_cancels table
        if(format==1){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'DISPENSER_CANCEL');
            await this.indexerDb.createDispenserCancel(dispenser);
        }

        // Update action from DISPENSER to DISPENSER_EDIT and create record in dispenser_edits table
        if(format==2){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'DISPENSER_EDIT');
            await this.indexerDb.createDispenserEdit(dispenser);

            // Observability: a valid edit that re-dates EXPIRATION moves the indexer's
            // effective expiry while the upstream decoder still holds the original. Log
            // the change (old vs new, shortened vs lengthened) so this half of the split
            // can be sized from logs. dispenserInfo['EXPIRATION'] is the current effective
            // value (prior edits applied). Measurement only - no state change.
            if(status=='valid' && !this.util.isNull(data['EXPIRATION']) && dispenserInfo &&
               Number(data['EXPIRATION']) !== Number(dispenserInfo['EXPIRATION']))
                divergenceMetrics.recordExpirationEdit(this.config['COIN'], data['BLOCK_INDEX'],
                    data['DISPENSER_ACTION_INDEX'], dispenserInfo['GET_ADDRESS'],
                    dispenserInfo['EXPIRATION'], data['EXPIRATION']);
        }

        // Store the SOURCE, GIVE_TICK, and GET_TICK in addresses list
        if(format==0){
            this.util.addAddressTicker(data['SOURCE'], [data['GIVE_TICK'], data['GET_TICK']]);
            this.util.addAddressTicker(data['GET_ADDRESS'], [data['GIVE_TICK'], data['GET_TICK']]);
        } else {
            this.util.addAddressTicker(dispenserInfo['SOURCE'], [dispenserInfo['GIVE_TICK'], dispenserInfo['GET_TICK']]);
            this.util.addAddressTicker(dispenserInfo['GET_ADDRESS'], [dispenserInfo['GIVE_TICK'], dispenserInfo['GET_TICK']]);
        }

    ctx.data = data;
    ctx.status = status;
    },

    // The credits, debits and escrow rows, the fee and guard-gas billing, and the
    // balance and token refresh. Skipped in full when the action did not validate.
    async applyDispenserLedger(ctx){
    let { data, status } = ctx;

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // If this was a valid transaction, add GIVE_AMOUNT to escrow
        if(status=='valid')
            await this.applyValidDispenserLedger(ctx, credits, debits, escrows);

        // Create action mappings
        await this.mapper.createMappings(data);

    ctx.data = data;
    },

    // The valid-only half of the ledger pass, taking the three row arrays the caller
    // declared so the shape of the block is what it was inside the if(status=='valid').
    async applyValidDispenserLedger(ctx, credits, debits, escrows){
    let { data, format, isOwnershipGive, dispenserInfo, giveTokenInfo, fees, guardFee } = ctx;

            // If we are charging a fee, store the SOURCE and fees TICK in addresses list
            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Debit GIVE_ESCROW GIVE_TICK from SOURCE and add to escrow (skip for ownership)
            if((format==0||format==2) && !isOwnershipGive && !this.util.isNull(data['GIVE_ESCROW'])){
                debits.push([giveTokenInfo['TICK'], data['GIVE_ESCROW'], data['SOURCE']]);
                escrows.push([giveTokenInfo['TICK'], data['GIVE_ESCROW'], data['SOURCE']]);
            }

            // Format 0 - Create Dispenser
            if(format==0){
                if(isOwnershipGive){
                    // Ownership dispenser: no balance escrow; mark the tick as ownership-escrowed
                    // for this dispenser. tokens.owner_id stays at SOURCE; admin actions are gated
                    // by escrow_action_index until DISPENSE / cancel / expire clears it.
                    await this.indexerDb.setTokenEscrow(data['GIVE_TICK'], data['ACTION_INDEX']);
                }
                await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');
            }

            // Format 1 - Cancel Dispenser
            // Note: Dispenser remains open for a set amount of time (DISPENSER_CLOSE_DELAY) before being closed.
            // Record SOURCE as the canceller so dispenser_close can route escrow per DISPENSER.md rules.
            if(format==1)
                await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], dispenserInfo['ACTION_INDEX'], 'cancelling', data['SOURCE']);

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Bill the controller-guard gas to SOURCE (in GAS), reserved above.
            if(this.util.bcgt(guardFee, 0)){
                debits.push([this.config['GAS'], guardFee, data['SOURCE']]);
                this.util.addAddressTicker(data['SOURCE'], this.config['GAS']);
            }

            // Process any transaction ledger changes (credits / debits / escrows)
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

            // Get a list of tickers & addresses
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            // Update address balances and token supply
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);

    ctx.data = data;
    },
};


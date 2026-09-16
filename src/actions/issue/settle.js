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
 * ISSUE settlement: the issues row every ISSUE writes, valid or not, and the effect of
 * a valid one: the fee, the token record, any controller binding event, and the
 * MINT_SUPPLY credit.
 *
 * Each function runs with `this` bound to the Issue handler (./index.js calls each as
 * fn.call(this, ctx)) and reads the shared context.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');
const controllerBinding = require('./controller_binding.js');

// The final STATUS, the issues row and the address bookkeeping every ISSUE gets, valid
// or not. Returns the status so the entry knows whether to settle.
async function recordIssue(ctx){
    let { data, issue, error } = ctx;

    // Determine final status
    let status = (error) ? error : 'valid';
    data['STATUS'] = issue['STATUS'] = status;

    // Print status message
    getLogger().info("\t ISSUE : " + data['TICK'] + ' : ' + data['STATUS']);

    // Create record in issues table
    await this.indexerDb.createIssue(issue);

    // Store the SOURCE and TICK in addresses list
    this.util.addAddressTicker(data['SOURCE'], data['TICK']);

    // Store the TRANSFER_SUPPLY and TICK in addresses list
    if(!this.util.isNull(data['TRANSFER_SUPPLY']))
        this.util.addAddressTicker(data['TRANSFER_SUPPLY'], data['TICK']);

    return status;
}

// If this was a valid transaction, then create the token record, and perform any
// additional actions: the fee, the ownership transfer, the controller event, the
// MINT_SUPPLY credit, the ledger write and the balance and supply refresh.
async function settleValidIssue(ctx){
    let { data, fees } = ctx;

    // Array of credits and debits
    let credits = [],
        debits  = [];

    // If we are charging a fee, store the SOURCE and fees TICK in addresses list
    if(this.util.bcgt(fees['AMOUNT'], 0))
        this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

    // Handle any transaction FEE according the users's ADDRESS preferences
    [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

    // Support token ownership transfers
    data['OWNER']  = (!this.util.isNull(data['TRANSFER'])) ? data['TRANSFER'] : data['SOURCE'];

    // Create/update record in tokens table
    await this.indexerDb.createToken(data);

    // Programmable policy layer: the format-6 bind/unbind event (see controller_binding.js)
    await controllerBinding.recordControllerEvent.call(this, ctx);

    // Credit MINT_SUPPLY to source address
    if(data['MINT_SUPPLY'])
        credits.push([data['TICK'], data['MINT_SUPPLY'], data['SOURCE']]);

    // Transfer MINT_SUPPLY to TRANSFER_SUPPLY address
    if(data['MINT_SUPPLY'] && data['TRANSFER_SUPPLY']){
        debits.push([data['TICK'],  data['MINT_SUPPLY'], data['SOURCE']]);
        credits.push([data['TICK'], data['MINT_SUPPLY'], data['TRANSFER_SUPPLY']]);
    }

    // Process any transaction ledger changes (credits / debits)
    await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

    // Get a list of tickers & addresses
    let tickers   = this.util.getTickersList(),
        addresses = Object.keys(this.util.getAddressesList());

    // Update address balances and token supply
    await this.indexerDb.updateBalances(addresses);
    await this.indexerDb.updateTokens(tickers);
}

module.exports = { recordIssue, settleValidIssue };

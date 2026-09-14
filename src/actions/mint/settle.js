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
 * MINT settlement: the mints row every MINT writes, valid or not, and the ledger
 * effect of a valid one.
 *
 * Runs with `this` bound to the Mint handler (./index.js calls each as fn.call(this, ctx)).
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

// The final STATUS, the mints row and the address bookkeeping every MINT gets, valid or
// not. Returns the status so the entry knows whether to settle.
async function recordMint(ctx){
    let { data, mint, error } = ctx;

    // Determine final status
    let status = (error) ? error : 'valid';
    data['STATUS'] = mint['STATUS'] = status;

    // Print status message
    getLogger().info("\t MINT : " + data['TICK'] + ' : '  +  this.util.logAmount(data['AMOUNT']) + ' : ' + data['STATUS']);

    // Create record in mints table
    await this.indexerDb.createMint(mint);

    // Store the SOURCE and TICK in addresses list
    this.util.addAddressTicker(data['SOURCE'], data['TICK']);

    // Store the DESTINATION and TICK in addresses list
    if(!this.util.isNull(data['DESTINATION']))
        this.util.addAddressTicker(data['DESTINATION'], data['TICK']);

    return status;
}

// The valid path: credit the minted AMOUNT to SOURCE (moving it on to DESTINATION when
// one is named), bill the controller-guard gas, then write the ledger changes and
// refresh balances and supply.
async function settleValidMint(ctx){
    let { data, guardFee } = ctx;

    // Array of credits and debits
    let credits = [],
        debits  = [];

    // Credit MINT_SUPPLY to source address
    if(data['AMOUNT']){
        credits.push([data['TICK'], data['AMOUNT'], data['SOURCE']]);

        // Transfer AMOUNT to DESTINATION address
        if(data['DESTINATION']){
            debits.push([data['TICK'],  data['AMOUNT'], data['SOURCE']]);
            credits.push([data['TICK'], data['AMOUNT'], data['DESTINATION']]);
        }
    }

    // Bill the controller-guard gas to SOURCE (GAS burn, no offsetting credit). updateTokens
    // below already recomputes GAS supply so the per-block sanityCheck stays balanced.
    if(this.util.bcgt(guardFee, 0)){
        debits.push([this.config['GAS'], guardFee, data['SOURCE']]);
        this.util.addAddressTicker(data['SOURCE'], this.config['GAS']);
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

module.exports = { recordMint, settleValidMint };

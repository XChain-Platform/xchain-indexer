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
 * DESTROY settlement: each leg's destroys row and debits, then the one ledger write
 * and balance/supply refresh for the whole action.
 *
 * Runs with `this` bound to the Destroy handler (./index.js calls each as
 * fn.call(this, ...)).
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

// One leg's final STATUS, its destroys row and address bookkeeping, and on the valid
// path its debits: the burned AMOUNT, plus the guard gas, which also comes off the
// shared in-memory GAS balance so a later controlled leg sees the spend.
async function recordLeg(data, destroy, error, guardFee, gas, debits){
    // Determine final status
    let status = (error) ? error : 'valid';
    data['STATUS'] = destroy['STATUS'] = status;

    // Print status message
    getLogger().info("\t DESTROY : " + destroy['TICK'] + ' : ' + this.util.logAmount(destroy['AMOUNT']) + ' : ' + destroy['MEMO'] + ' : '+ data['STATUS']);

    // Create record in destroys table
    await this.indexerDb.createDestroy(destroy);

    // Store the SOURCE and TICK in addresses list
    this.util.addAddressTicker(destroy['SOURCE'], destroy['TICK']);

    // If this was a valid transaction, then add records to the credits and debits array
    if(status=='valid'){

        // Add ticker and amount to debits array
        debits.push([destroy['TICK'], destroy['AMOUNT'], destroy['SOURCE']]);

        // Bill the controller-guard gas to SOURCE (in GAS). Reduce the in-memory GAS
        // balance so a later controlled leg in this same multi-destroy sees the spend.
        if(this.util.bcgt(guardFee, 0)){
            debits.push([gas.gasTick, guardFee, destroy['SOURCE']]);
            this.util.addAddressTicker(destroy['SOURCE'], gas.gasTick);
            if(gas.gasInfo)
                gas.gasBalances = this.util.debitBalances(gas.gasBalances, gas.gasInfo['TICK_ID'], guardFee);
        }
    }
}

// The action's ledger write, once every leg is recorded, then the balance and supply
// refresh for every address and ticker the legs touched.
async function settleLedger(data, credits, debits){
    // Process any transaction ledger changes (credits / debits)
    await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

    // Get a list of tickers & addresses
    let tickers   = this.util.getTickersList(),
        addresses = Object.keys(this.util.getAddressesList());

    // Update address balances and token supply
    await this.indexerDb.updateBalances(addresses);
    await this.indexerDb.updateTokens(tickers);
}

module.exports = { recordLeg, settleLedger };

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
 * XChain Platform Action - WITHDRAW
 *
 * This action withdraws tokens from a contract's custody back to the owner.
 * Only the contract owner (deployer) can withdraw.
 * No gas fee; on-chain transaction cost is sufficient.
 *
 * PARAMS:
 * - VERSION              - Format Version
 * - CONTRACT_ACTION_INDEX - Action index of the deployed contract
 * - TICK                 - Ticker name or Ticker ID
 * - QUANTITY             - Amount of tokens to withdraw
 *
 * FORMATS:
 * - 0 = Withdraw tokens from contract
 *
 ********************************************************************/

class Withdraw {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|CONTRACT_ACTION_INDEX|TICK|QUANTITY';
    }

    // Handle parsing the WITHDRAW transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Extract params
        data['CONTRACT_ACTION_INDEX'] = params[1];
        data['TICK']                  = params[2];
        data['AMOUNT']                = params[3];

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Contract Validations
         ****************************************************************/

        // Verify CONTRACT_ACTION_INDEX is provided
        if(!error && this.util.isNull(data['CONTRACT_ACTION_INDEX']))
            error = 'invalid: CONTRACT_ACTION_INDEX (required)';

        // Verify CONTRACT_ACTION_INDEX is a canonical integer index (see deposit.js: a
        // coercible non-canonical form would resolve a real contract but derive a phantom
        // custody address string, and non-numeric junk must not reach the row write).
        if(!error && !/^\d+$/.test(String(data['CONTRACT_ACTION_INDEX'])))
            error = 'invalid: CONTRACT_ACTION_INDEX (format)';

        // Verify contract exists
        let contractInfo = null;
        if(!error){
            contractInfo = await this.indexerDb.getContract(data['CONTRACT_ACTION_INDEX']);
            if(!contractInfo)
                error = 'invalid: CONTRACT_ACTION_INDEX (unknown)';
        }

        // Verify caller is contract owner
        if(!error && contractInfo){
            let ownerId = await this.indexerDb.getAddressId(data['SOURCE']);
            if(ownerId === null || Number(ownerId) !== Number(contractInfo.source_id))
                error = 'invalid: SOURCE (not contract owner)';
        }

        /*****************************************************************
         * Token Validations
         ****************************************************************/

        // Get information on token
        let tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Verify TICK exists
        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        // Verify AMOUNT format
        if(!error && !this.util.isNull(data['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], data['AMOUNT']))
            error = 'invalid: AMOUNT (format)';

        // Verify AMOUNT is greater than 0
        if(!error && !this.util.bcgt(data['AMOUNT'], 0))
            error = 'invalid: AMOUNT (zero)';

        // Verify contract has sufficient balance at its derived address
        let contractAddress = 'C:' + this.config['CHAIN'] + ':' + data['CONTRACT_ACTION_INDEX'];
        if(!error){
            let contractBalances = await this.indexerDb.getAddressBalances(contractAddress, null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(!this.util.hasBalance(contractBalances, tokenInfo['TICK_ID'], data['AMOUNT']))
                error = 'invalid: insufficient contract balance';
        }

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t WITHDRAW : contract=" + data['CONTRACT_ACTION_INDEX'] + ' : ' + data['TICK'] + ' : ' + data['AMOUNT'] + ' : ' + data['STATUS']);

        // Create record in withdrawals table
        await this.indexerDb.createWithdrawal(data);

        // Store the SOURCE, contract address, and TICK in addresses list
        this.util.addAddressTicker(data['SOURCE'], data['TICK']);
        if(status === 'valid')
            this.util.addAddressTicker(contractAddress, data['TICK']);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Debit from contract derived address, credit to SOURCE
        if(status === 'valid'){
            debits.push([data['TICK'], data['AMOUNT'], contractAddress]);
            credits.push([data['TICK'], data['AMOUNT'], data['SOURCE']]);
        }

        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = Withdraw;

/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform Action - EXECUTE
 *
 * This action executes a method on a deployed smart contract.
 *
 * PARAMS:
 * - VERSION              - Format Version
 * - CONTRACT_ACTION_INDEX - Action index of the deployed contract
 * - METHOD               - Method name to call
 * - PARAMS               - Method parameters (pipe-delimited after method)
 *
 * FORMATS:
 * - 0 = Execute a contract method
 *
 ********************************************************************/

class Execute {

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
        this.formats[0] = 'VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...';
    }

    // Handle parsing the EXECUTE transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Extract params
        data['CONTRACT_ACTION_INDEX'] = params[1];
        data['METHOD']                = params[2];
        // Remaining params are method arguments
        data['METHOD_PARAMS']         = params.slice(3).join('|');

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Contract Validations
         ****************************************************************/

        // Verify CONTRACT_ACTION_INDEX is provided
        if(!error && this.util.isNull(data['CONTRACT_ACTION_INDEX']))
            error = 'invalid: CONTRACT_ACTION_INDEX (required)';

        // Verify METHOD is provided
        if(!error && this.util.isNull(data['METHOD']))
            error = 'invalid: METHOD (required)';

        // Verify contract exists and is active
        let contractInfo = null;
        if(!error){
            contractInfo = await this.indexerDb.getContract(data['CONTRACT_ACTION_INDEX']);
            if(!contractInfo)
                error = 'invalid: CONTRACT_ACTION_INDEX (unknown)';
        }

        // Verify contract is valid/active
        if(!error && contractInfo){
            let contractStatus = await this.indexerDb.getStatusString(contractInfo.status_id);
            if(contractStatus !== 'valid')
                error = 'invalid: contract (not active)';
        }

        /*****************************************************************
         * Gas Fee Calculation
         ****************************************************************/

        let schedule = this.config['GAS_SCHEDULE'];
        // Base execution gas (actual VM gas will be metered during execution)
        let gasCost = schedule.VM_EXECUTE_BASE;
        let fee = this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8);

        // Get source address balances
        let gas = this.config['GAS'];
        let tokenInfo = await this.indexerDb.getTokenInfo(gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Verify SOURCE has enough XCHAIN to cover base gas fee
        if(!error && tokenInfo && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], fee))
            error = 'invalid: insufficient funds (GAS)';

        // Adjust balances to reduce by gas fee
        if(!error && tokenInfo)
            balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], fee);

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        /*****************************************************************
         * VM Execution
         * TODO: Integrate xchain-vm runtime when built (Phase 3A)
         * For now, record the execution attempt and charge base gas
         ****************************************************************/

        let gasUsed = gasCost;
        let emittedCount = 0;
        let vmError = null;

        // TODO: Load contract code, build sandbox, execute, collect emitted actions
        // let vmResult = await vm.execute(contractInfo.code, contractState, inputs, blockContext);
        // gasUsed = vmResult.gasUsed;
        // emittedCount = vmResult.emittedActions.length;
        // vmError = vmResult.error;

        if(vmError && !error)
            error = 'invalid: VM execution error: ' + vmError;

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t EXECUTE : contract=" + data['CONTRACT_ACTION_INDEX'] + ' : method=' + data['METHOD'] + ' : gas=' + gasUsed + ' : ' + data['STATUS']);

        // Create execution record
        await this.indexerDb.createContractExecution({
            ACTION_INDEX    : data['ACTION_INDEX'],
            CONTRACT_INDEX  : data['CONTRACT_ACTION_INDEX'],
            CALLER          : data['SOURCE'],
            METHOD_NAME     : data['METHOD'],
            INPUT_PARAMS    : data['METHOD_PARAMS'],
            GAS_USED        : gasUsed,
            GAS_LIMIT       : gasUsed, // TODO: user-specified gas limit
            STATUS          : status,
            ERROR_MESSAGE   : error || null,
            EMITTED_COUNT   : emittedCount,
            BLOCK_INDEX     : data['BLOCK_INDEX']
        });

        // Store the SOURCE and GAS tick in addresses list
        this.util.addAddressTicker(data['SOURCE'], gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Debit gas fee from SOURCE
        if(status === 'valid')
            debits.push([gas, fee, data['SOURCE']]);

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

module.exports = Execute;

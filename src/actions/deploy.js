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
 * XChain Platform Action - DEPLOY
 *
 * This action deploys a smart contract to the XChain VM.
 *
 * PARAMS:
 * - VERSION            - Format Version
 * - CODE_ENCODING      - Contract code (hex-encoded)
 * - GAS_LIMIT          - Maximum gas units for deployment
 * - CONSTRUCTOR_PARAMS - Optional constructor parameters (JSON)
 *
 * FORMATS:
 * - 0 = Deploy a contract
 *
 ********************************************************************/

const crypto = require('crypto');

class Deploy {

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
        this.formats[0] = 'VERSION|CODE_ENCODING|GAS_LIMIT|CONSTRUCTOR_PARAMS';

        // Maximum code size (64KB)
        this.MAX_CODE_SIZE = 65536;
    }

    // Handle parsing the DEPLOY transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Extract params
        data['CODE_ENCODING']      = params[1];
        data['GAS_LIMIT']          = params[2];
        data['CONSTRUCTOR_PARAMS'] = params[3];

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Code Validations
         ****************************************************************/

        // Verify CODE_ENCODING is provided
        if(!error && this.util.isNull(data['CODE_ENCODING']))
            error = 'invalid: CODE_ENCODING (required)';

        // Decode code from hex
        let code = '';
        if(!error){
            try {
                code = Buffer.from(data['CODE_ENCODING'], 'hex').toString('utf8');
            } catch(e){
                error = 'invalid: CODE_ENCODING (hex decode failed)';
            }
        }

        // Verify code size
        if(!error && Buffer.byteLength(code, 'utf8') > this.MAX_CODE_SIZE)
            error = 'invalid: CODE_ENCODING (exceeds max size)';

        // Verify GAS_LIMIT is provided and valid
        if(!error && (this.util.isNull(data['GAS_LIMIT']) || !this.util.isNumeric(data['GAS_LIMIT'])))
            error = 'invalid: GAS_LIMIT (required)';

        /*****************************************************************
         * VM Syntax Validation (before charging gas)
         ****************************************************************/

        let floatWarnings = [];
        if(!error && this.actions.vm){
            let syntaxResult = this.actions.vm.validateSyntax(code);
            if(!syntaxResult.valid)
                error = 'invalid: CODE_ENCODING (' + syntaxResult.error + ')';

            // Non-blocking float warnings (logged in execution record)
            if(!error)
                floatWarnings = this.actions.vm.checkFloatWarnings(code);
        }

        /*****************************************************************
         * Gas Fee Calculation
         ****************************************************************/

        let schedule = this.config['GAS_SCHEDULE'];
        let codeBytes = Buffer.byteLength(code, 'utf8');
        let gasCost = schedule.VM_DEPLOY_BASE + (codeBytes * schedule.VM_DEPLOY_PER_BYTE);
        let fee = this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8);

        // Get source address balances
        let gas = this.config['GAS'];
        let tokenInfo = await this.indexerDb.getTokenInfo(gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Verify SOURCE has enough XCHAIN to cover gas fee
        if(!error && tokenInfo && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], fee))
            error = 'invalid: insufficient funds (GAS)';

        // Adjust balances to reduce by gas fee
        if(!error && tokenInfo)
            balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], fee);

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Generate code hash
        let codeHash = crypto.createHash('sha256').update(code).digest('hex');

        /*****************************************************************
         * Contract Derived Address
         ****************************************************************/

        // Create the contract's derived address (C:<CHAIN>:<action_index>)
        let contractAddress = 'C:' + this.config['CHAIN'] + ':' + data['ACTION_INDEX'];
        if(!error)
            await this.indexerDb.createAddress(contractAddress);

        /*****************************************************************
         * Constructor Execution
         ****************************************************************/

        let totalGas = gasCost;
        let constructorError = null;
        let constructorResult = null;

        if(!error && data['CONSTRUCTOR_PARAMS'] && this.actions.vm){
            // Derive deterministic block hash
            let blockHash = crypto.createHash('sha256')
                .update(String(data['BLOCK_INDEX']) + ':' + String(data['BLOCK_TIME']))
                .digest('hex');

            constructorResult = await this.actions.vm.execute({
                code:             code,
                state:            {},
                method:           'initialize',
                params:           data['CONSTRUCTOR_PARAMS'].split('|'),
                caller:           data['SOURCE'],
                contractAddress:  contractAddress,
                contractIndex:    data['ACTION_INDEX'],
                blockContext: {
                    height:    data['BLOCK_INDEX'],
                    timestamp: data['BLOCK_TIME'],
                    hash:      blockHash
                },
                balances:         null,
                tokenInfo:        null,
                oracleData:       await this.indexerDb.getOracleDataForVM(data['BLOCK_INDEX']),
                crossChainData:   await this.indexerDb.getCrossChainDataForVM()
            });

            totalGas += constructorResult.gasUsed;

            if(!constructorResult.success){
                constructorError = 'constructor failed: ' + constructorResult.error;
                error = 'invalid: ' + constructorError;
            }
        }

        // Recalculate fee based on total gas (deploy + constructor)
        fee = this.util.bcmul(totalGas, this.config['GAS_PRICE'], 8);

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t DEPLOY : hash=" + codeHash + ' : gas=' + totalGas +
            (floatWarnings.length > 0 ? ' : FLOAT_WARNINGS=' + floatWarnings.length : '') +
            ' : ' + data['STATUS']);

        // Create record in contracts table
        await this.indexerDb.createContract({
            ACTION_INDEX : data['ACTION_INDEX'],
            SOURCE       : data['SOURCE'],
            CODE         : code,
            CODE_HASH    : codeHash,
            API_VERSION  : 1,
            STATUS       : status,
            BLOCK_INDEX  : data['BLOCK_INDEX']
        });

        // If constructor failed, delete the contract record
        if(constructorError)
            await this.indexerDb.deleteContract(data['ACTION_INDEX']);

        // Process constructor state changes and emissions if successful
        if(constructorResult && constructorResult.success){
            let savepoint = await this.indexerDb.createSavepoint('vm_constructor');
            try {
                for(let change of constructorResult.stateChanges){
                    await this.indexerDb.createContractState({
                        CONTRACT_INDEX: data['ACTION_INDEX'],
                        STATE_KEY:      change.key,
                        STATE_VALUE:    JSON.stringify(change.value),
                        BLOCK_INDEX:    data['BLOCK_INDEX'],
                        ACTION_INDEX:   data['ACTION_INDEX']
                    });
                }
                for(let key of constructorResult.stateDeletes){
                    await this.indexerDb.createContractState({
                        CONTRACT_INDEX: data['ACTION_INDEX'],
                        STATE_KEY:      key,
                        STATE_VALUE:    null,
                        BLOCK_INDEX:    data['BLOCK_INDEX'],
                        ACTION_INDEX:   data['ACTION_INDEX']
                    });
                }
                await this.indexerDb.releaseSavepoint(savepoint);
            } catch(e){
                await this.indexerDb.rollbackToSavepoint(savepoint);
                // Constructor state save failed — mark deployment as failed
                error = 'invalid: constructor state write failed: ' + e.message;
                status = error;
                data['STATUS'] = status;
                await this.indexerDb.deleteContract(data['ACTION_INDEX']);
            }
        }

        // Create execution record
        await this.indexerDb.createContractExecution({
            ACTION_INDEX    : data['ACTION_INDEX'],
            CONTRACT_INDEX  : data['ACTION_INDEX'], // contract_index = its own action_index
            CALLER          : data['SOURCE'],
            METHOD_NAME     : 'constructor',
            INPUT_PARAMS    : data['CONSTRUCTOR_PARAMS'] || '',
            GAS_USED        : totalGas,
            GAS_LIMIT       : data['GAS_LIMIT'] || totalGas,
            STATUS          : status,
            ERROR_MESSAGE   : error || null,
            EMITTED_COUNT   : constructorResult ? constructorResult.emittedActions.length : 0,
            BLOCK_INDEX     : data['BLOCK_INDEX']
        });

        // Store the SOURCE and GAS tick in addresses list
        this.util.addAddressTicker(data['SOURCE'], gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Debit gas fee from SOURCE
        if(tokenInfo)
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

module.exports = Deploy;

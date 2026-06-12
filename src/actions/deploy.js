/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
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
const ProviderRegistry = require('../attestation/providerRegistry.js');

// Per-provider deadline windows, injected into the VM gateway so a constructor's
// attestation.request() rejects an over-limit deadlineBlocks at call time rather
// than landing on-chain and being silently rejected by the indexer DEADLINE check.
// Sourced from the single provider registry so the two caps cannot drift.
const PROVIDER_DEADLINE_WINDOWS = new ProviderRegistry().getDeadlineWindows();

// Maximum smart-contract code size (64 KiB). Canonical value:
// xchain-documentation/protocol/constants.js (MAX_CODE_SIZE); kept equal to the
// SDK and VM by the cross-service regression suite, which reads the value
// exported at the bottom of this module.
const MAX_CODE_SIZE = 65536;

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
        // v1 adds optional staking config: COOLDOWN_BLOCKS + SLASH_DESTINATION (address or 'BURN' sentinel).
        // Contracts deployed without these fields cannot be stake targets.
        this.formats[1] = 'VERSION|CODE_ENCODING|GAS_LIMIT|CONSTRUCTOR_PARAMS|COOLDOWN_BLOCKS|SLASH_DESTINATION';

        // Maximum code size (64KB) — see the MAX_CODE_SIZE module constant above.
        this.MAX_CODE_SIZE = MAX_CODE_SIZE;

        // Cooldown bounds for contract-staking (DEPLOY v1+)
        this.MIN_COOLDOWN_BLOCKS = 1;
        this.MAX_COOLDOWN_BLOCKS = 100000;
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
        // v1+ optional staking config
        data['COOLDOWN_BLOCKS']    = (format >= 1) ? params[4] : null;
        data['SLASH_DESTINATION']  = (format >= 1) ? params[5] : null;

        // Validate v1 staking config (both optional, but pairing rules apply)
        if(!error && format === 1){
            let hasCooldown = !this.util.isNull(data['COOLDOWN_BLOCKS']) && data['COOLDOWN_BLOCKS'] !== '';
            let hasDest     = !this.util.isNull(data['SLASH_DESTINATION']) && data['SLASH_DESTINATION'] !== '';
            // SLASH_DESTINATION without COOLDOWN_BLOCKS is meaningless
            if(hasDest && !hasCooldown){
                error = 'invalid: SLASH_DESTINATION (requires COOLDOWN_BLOCKS)';
            }
            if(!error && hasCooldown){
                if(!this.util.isNumeric(data['COOLDOWN_BLOCKS'])){
                    error = 'invalid: COOLDOWN_BLOCKS (not numeric)';
                } else {
                    let cb = Number(data['COOLDOWN_BLOCKS']);
                    if(cb < this.MIN_COOLDOWN_BLOCKS || cb > this.MAX_COOLDOWN_BLOCKS){
                        error = 'invalid: COOLDOWN_BLOCKS (out of range)';
                    }
                }
            }
            // If contract opted into staking but didn't name a destination, default to BURN
            if(!error && hasCooldown && !hasDest){
                data['SLASH_DESTINATION'] = (this.config['ADDRESS'] && this.config['ADDRESS']['BURN']) || null;
            }
            // Resolve BURN sentinel to the configured BURN address
            if(!error && data['SLASH_DESTINATION'] === 'BURN'){
                data['SLASH_DESTINATION'] = (this.config['ADDRESS'] && this.config['ADDRESS']['BURN']) || null;
                if(this.util.isNull(data['SLASH_DESTINATION']))
                    error = 'invalid: SLASH_DESTINATION (BURN address not configured)';
            }
            // Clear staking config on non-stakeable deployments so createContract stores NULLs
            if(!hasCooldown){
                data['COOLDOWN_BLOCKS']   = null;
                data['SLASH_DESTINATION'] = null;
            }
        }

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

        // Validate gas fee payment (native coin or XCHAIN balance)
        let feePaymentMode = 2; // default: xchain balance
        if(!error && tokenInfo && this.util.bcgt(fee, 0)){
            let pmMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(pmMode === 'native'){
                let tempFees = { AMOUNT: fee };
                let validation = await this.util.validateNativeCoinFee(data, tempFees, this.indexerDb, data['TX_OUTPUTS']);
                if(!validation.valid){
                    error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                } else {
                    feePaymentMode = 1;
                    data['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                    data['NATIVE_COIN']        = validation.nativeCoin;
                    data['ORACLE_ROUND']       = validation.oracleRound;
                }
            } else if(pmMode === 'rejected'){
                error = 'invalid: insufficient fee (native coin output required)';
            } else {
                if(!this.util.hasBalance(balances, tokenInfo['TICK_ID'], fee))
                    error = 'invalid: insufficient funds (GAS)';
            }
        }

        // Adjust balances to reduce by gas fee (only for XCHAIN deduction mode)
        if(!error && tokenInfo && feePaymentMode === 2)
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
                // The tx hash + this DEPLOY's action_index anchor the deterministic
                // attestation request_id (sha256(txHash:actionIndex:contractIndex:
                // emissionIndex)) — without them a constructor-emitted ATTEST would
                // derive over empty fields and fail the handler's re-derivation.
                txHash:           data['TX_HASH'],
                actionIndex:      data['ACTION_INDEX'],
                // A constructor is a root execution: emitted cross-contract calls
                // run at depth 1, same as calls emitted by a user EXECUTE.
                callDepth:        0,
                blockContext: {
                    height:    data['BLOCK_INDEX'],
                    timestamp: data['BLOCK_TIME'],
                    hash:      blockHash
                },
                balances:         null,
                tokenInfo:        null,
                oracleData:       await ((this.actions && this.actions.hubDb) || this.indexerDb).getOracleDataForVM(data['BLOCK_INDEX'], data['BLOCK_TIME'], parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800),
                crossChainData:   await this.indexerDb.getCrossChainDataForVM(data['BLOCK_INDEX']),
                providerDeadlines: PROVIDER_DEADLINE_WINDOWS
            });

            // Defense-in-depth (consensus): mirror the gasUsed clamp in actions/execute.js so a
            // resource termination in the constructor can never make totalGas — hashed via
            // contract_executions.gas_used → contract_hash — diverge across validators. The
            // VM already clamps these; this guards a VM regression. Keep the family regex
            // identical to util.vmFailureStatus and execute.js (out_of_gas included so the
            // regexes never drift — a no-op for the fee since out_of_gas == ceiling already).
            let constructorGas = constructorResult.gasUsed;
            if(!constructorResult.success && /^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(String(constructorResult.error)))
                constructorGas = 1000000;
            totalGas += constructorGas;

            if(!constructorResult.success){
                constructorError = 'constructor failed: ' + constructorResult.error;
                error = 'invalid: ' + constructorError;
            }
        }

        // Recalculate fee based on total gas (deploy + constructor)
        fee = this.util.bcmul(totalGas, this.config['GAS_PRICE'], 8);

        // Determine final status. This is consensus-hashed (contracts.status_id /
        // contract_executions.status_id → contract_hash), so it MUST be deterministic. A
        // failed constructor's raw VM error is timing-/memory-/arch-dependent (V8 abort vs
        // isolate wall-clock vs parent watchdog — see util.vmFailureStatus), so normalize it to
        // a stable token instead of storing the raw 'invalid: constructor failed: <vm error>'
        // string. Pre-VM rejections keep their deterministic 'invalid: ...' message; a clean
        // deploy is 'valid'. The raw detail is preserved (un-hashed) in
        // contract_executions.ERROR_MESSAGE below.
        let status;
        if(constructorResult && !constructorResult.success)
            status = this.util.vmFailureStatus(constructorResult.error);
        else if(error)
            status = error;
        else
            status = 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t DEPLOY : hash=" + codeHash + ' : gas=' + totalGas +
            (floatWarnings.length > 0 ? ' : FLOAT_WARNINGS=' + floatWarnings.length : '') +
            ' : ' + data['STATUS']);

        // Create record in contracts table
        await this.indexerDb.createContract({
            ACTION_INDEX      : data['ACTION_INDEX'],
            SOURCE            : data['SOURCE'],
            CODE              : code,
            CODE_HASH         : codeHash,
            API_VERSION       : 1,
            STATUS            : status,
            BLOCK_INDEX       : data['BLOCK_INDEX'],
            COOLDOWN_BLOCKS   : data['COOLDOWN_BLOCKS'],
            SLASH_DESTINATION : data['SLASH_DESTINATION']
        });

        // If constructor failed, delete the contract record
        if(constructorError)
            await this.indexerDb.deleteContract(data['ACTION_INDEX']);

        // Process constructor state changes and emissions if successful.
        // Emissions route through the SAME pipeline as EXECUTE emissions
        // (Execute.processEmission): real action rows, contract-derived SOURCE,
        // cross-contract EXECUTE support with depth/gasLimit threading. The
        // savepoint name is unique per deployment because an emitted EXECUTE
        // nests its own vm_execute_<idx> savepoints inside this one (MariaDB
        // destroys a re-used savepoint name — see actions/execute.js).
        let nestedGasUnused = 0;
        if(constructorResult && constructorResult.success){
            let savepoint = await this.indexerDb.createSavepoint('vm_constructor_' + parseInt(data['ACTION_INDEX']));
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

                // Constructor emissions. executionData mirrors what an EXECUTE
                // would carry: the new contract is the emitter, the DEPLOY's own
                // action_index is the executing action (parent for CALL_DEPTH and
                // the attestation request_id derivation), the deployer pays fees.
                let emissionContext = {
                    CONTRACT_ACTION_INDEX: data['ACTION_INDEX'],
                    ACTION_INDEX:          data['ACTION_INDEX'],
                    SOURCE:                data['SOURCE'],
                    BLOCK_INDEX:           data['BLOCK_INDEX'],
                    BLOCK_TIME:            data['BLOCK_TIME'],
                    TX_INDEX:              data['TX_INDEX'],
                    TX_HASH:               data['TX_HASH'],
                    TX_VOUT:               data['TX_VOUT'],
                    CALL_DEPTH:            0,
                    IS_CONSTRUCTOR:        true   // cross-chain calls are disallowed from constructors (v1)
                };
                for(let i = 0; i < constructorResult.emittedActions.length; i++){
                    let emission = constructorResult.emittedActions[i];

                    if(emission.action === 'SLASH'){
                        // Inline like execute.js (never on-wire). A just-deployed
                        // contract has no stakes, so this is a structural no-op,
                        // kept for pipeline parity.
                        await this.actions.actionExecute._processSlashEmission(emission, emissionContext);
                    } else {
                        await this.actions.actionExecute.processEmission(emission, emissionContext, i);
                        // Bank a cross-contract callee's unused reservation for
                        // the fee settlement below.
                        if(emission.action === 'EXECUTE')
                            nestedGasUnused += Number(emission.gasUnusedSubtree) || 0;
                    }

                    await this.indexerDb.createContractEmission({
                        EXECUTION_INDEX: data['ACTION_INDEX'],
                        EMITTED_ACTION:  emission.action,
                        ACTION_INDEX:    emission.resultActionIndex || null,
                        POSITION:        i
                    });
                }

                await this.indexerDb.releaseSavepoint(savepoint);
            } catch(e){
                await this.indexerDb.rollbackToSavepoint(savepoint);
                // Constructor state/emission processing failed — the whole
                // deployment fails (no refunds; the deployer pays full gas).
                nestedGasUnused = 0;
                error = 'invalid: constructor state write failed: ' + e.message;
                status = error;
                data['STATUS'] = status;
                await this.indexerDb.deleteContract(data['ACTION_INDEX']);
            }
        }

        // Refund unused cross-contract reservations from constructor emissions
        // (mirrors actions/execute.js gas settlement; no-op when no emit.execute).
        if(nestedGasUnused > 0){
            totalGas = Math.max(0, totalGas - nestedGasUnused);
            fee = this.util.bcmul(totalGas, this.config['GAS_PRICE'], 8);
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

        // Debit gas fee from SOURCE — mirror the in-memory balance debit above
        // EXACTLY (!error && feePaymentMode === 2). Recording a ledger debit for a
        // rejected deploy (e.g. one rejected for insufficient GAS funds) burns gas
        // the source never had: the ledger supply drops but getAddressBalances only
        // iterates credit ticks, so the debit-only tick is invisible to the balances
        // projection — leaving balance = ledger + 1 and tripping the supply SanityError.
        if(!error && tokenInfo && feePaymentMode === 2)
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
// Expose the canonical code-size cap so the cross-service regression suite can
// assert it has not drifted from the protocol constant.
module.exports.MAX_CODE_SIZE = MAX_CODE_SIZE;

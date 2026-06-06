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

const crypto = require('crypto');
const ProviderRegistry = require('../attestation/providerRegistry.js');

// Per-provider deadline windows, injected into the VM gateway so a contract's
// attestation.request() rejects an over-limit deadlineBlocks at call time rather
// than landing on-chain and being silently rejected here by the DEADLINE check.
// Sourced from the single provider registry so the two caps cannot drift.
const PROVIDER_DEADLINE_WINDOWS = new ProviderRegistry().getDeadlineWindows();

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

        // Validate gas fee payment (native coin or XCHAIN balance).
        // System-injected EXECUTEs (e.g. attestation callbacks via attestation_response.js)
        // skip fee accounting — those run against the request's gas_escrow, not the
        // synthetic SOURCE's wallet. Pre-escrow (Phase 1) means fee is simply skipped;
        // Phase 3 economics deducts the actual cost from gas_escrow on the request row.
        let feePaymentMode = 2; // default: xchain balance
        let skipFee = Boolean(data['IS_EMISSION']);
        if(!error && !skipFee && tokenInfo && this.util.bcgt(fee, 0)){
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

        // Adjust balances to reduce by gas fee (only for XCHAIN deduction mode, never for system-injected)
        if(!error && !skipFee && tokenInfo && feePaymentMode === 2)
            balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], fee);

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        /*****************************************************************
         * VM Execution
         ****************************************************************/

        let gasUsed = gasCost;
        let emittedCount = 0;
        let vmError = null;

        if(!error && this.actions.vm && contractInfo){
            // Load contract state from DB
            let contractState = await this.indexerDb.getContractState(data['CONTRACT_ACTION_INDEX']);

            // Load read-only data for gateway (price data lives in local hub DB when configured)
            let oracleData = await ((this.actions && this.actions.hubDb) || this.indexerDb).getOracleDataForVM(data['BLOCK_INDEX'], data['BLOCK_TIME'], parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800);
            let crossChainData = await this.indexerDb.getCrossChainDataForVM();

            // Pre-load contract-stake snapshot scoped to THIS contract — backs the
            // xchain.contract.{getStake,getTotalStaked,getStakers,slash} APIs synchronously.
            // Implicit slash authorization: the accessor only knows this contract's stakes.
            let contractStakeData = await this.indexerDb.getContractStakeDataForVM(
                data['CONTRACT_ACTION_INDEX'], data['BLOCK_INDEX']
            );

            // Derive deterministic block hash from block_index + block_time
            let blockHash = crypto.createHash('sha256')
                .update(String(data['BLOCK_INDEX']) + ':' + String(data['BLOCK_TIME']))
                .digest('hex');

            // Execute contract in VM
            let vmResult = await this.actions.vm.execute({
                code:             contractInfo.code,
                state:            contractState,
                method:           data['METHOD'],
                params:           data['METHOD_PARAMS'] ? data['METHOD_PARAMS'].split('|') : [],
                caller:           data['SOURCE'],
                contractAddress:  'C:' + this.config['CHAIN'] + ':' + data['CONTRACT_ACTION_INDEX'],
                contractIndex:    data['CONTRACT_ACTION_INDEX'],
                txHash:           data['TX_HASH'],   // needed for deterministic attestation request_id
                blockContext: {
                    height:    data['BLOCK_INDEX'],
                    timestamp: data['BLOCK_TIME'],
                    hash:      blockHash
                },
                balances:          null, // TODO: load balances for getBalance() when needed
                tokenInfo:         null, // TODO: load token info for getTokenInfo() when needed
                oracleData:        oracleData,
                crossChainData:    crossChainData,
                attestationData:   null, // TODO: wire getResponse() reader once response retention is in place
                contractStakeData: contractStakeData,
                providerDeadlines: PROVIDER_DEADLINE_WINDOWS
            });

            gasUsed = vmResult.gasUsed;
            emittedCount = vmResult.emittedActions.length;

            if(!vmResult.success)
                vmError = vmResult.error;

            // Process state changes + emissions atomically via DB savepoint
            if(vmResult.success){
                let savepoint = await this.indexerDb.createSavepoint('vm_execute');
                try {
                    // Write state changes
                    for(let change of vmResult.stateChanges){
                        await this.indexerDb.createContractState({
                            CONTRACT_INDEX: data['CONTRACT_ACTION_INDEX'],
                            STATE_KEY:      change.key,
                            STATE_VALUE:    JSON.stringify(change.value),
                            BLOCK_INDEX:    data['BLOCK_INDEX'],
                            ACTION_INDEX:   data['ACTION_INDEX']
                        });
                    }
                    // Write state deletes (null value = deleted)
                    for(let key of vmResult.stateDeletes){
                        await this.indexerDb.createContractState({
                            CONTRACT_INDEX: data['CONTRACT_ACTION_INDEX'],
                            STATE_KEY:      key,
                            STATE_VALUE:    null,
                            BLOCK_INDEX:    data['BLOCK_INDEX'],
                            ACTION_INDEX:   data['ACTION_INDEX']
                        });
                    }
                    // Process emitted actions through existing handlers
                    for(let i = 0; i < vmResult.emittedActions.length; i++){
                        let emission = vmResult.emittedActions[i];

                        // SLASH emissions are internal — never on-wire, never run through
                        // the generic emission router (no decoder/parser exists for them).
                        // Handled inline: deduct stake, credit destination, write event log.
                        if(emission.action === 'SLASH'){
                            await this._processSlashEmission(emission, data);
                        } else {
                            await this.processEmission(emission, data, i);
                        }

                        // Record emission link (SLASH rows carry no resultActionIndex)
                        await this.indexerDb.createContractEmission({
                            EXECUTION_INDEX: data['ACTION_INDEX'],
                            EMITTED_ACTION:  emission.action,
                            ACTION_INDEX:    emission.resultActionIndex || null,
                            POSITION:        i
                        });
                    }

                    await this.indexerDb.releaseSavepoint(savepoint);
                } catch(emissionError){
                    // Roll back ALL state changes and emissions from this execution
                    await this.indexerDb.rollbackToSavepoint(savepoint);
                    vmError = 'emission failed: ' + emissionError.message;
                    emittedCount = 0;
                }
            }
        }

        // A VM-execution failure (revert / out_of_gas / timeout / runtime error) is NOT a
        // pre-VM rejection: the contract DID run and consumed gas, so the caller pays for the
        // failed attempt (see the gas-debit note below). Atomicity is preserved — state changes
        // and emissions are applied only on vmResult.success. We record a dedicated execution
        // status ('reverted' / 'out_of_gas' / 'out_of_resource' / 'failed', via
        // util.vmFailureStatus) and deliberately leave
        // `error` null so the gas debit fires, mirroring the in-memory debit taken before the
        // VM ran. (Leaving it as a generic 'invalid:' error would skip the debit, letting any
        // caller burn up to the gas ceiling / CPU limit for free — a node-DoS vector.)
        let vmFailed = Boolean(vmError) && !error;
        let vmStatus = vmFailed ? this.util.vmFailureStatus(vmError) : null;

        // Defense-in-depth (consensus): non-gas resource terminations report a
        // gasUsed captured at a machine-/GC-/stack-/timing-dependent point. The VM
        // already clamps these to the ceiling, but clamp here too so a VM regression
        // (or an older bundled VM) can never make fee = gasUsed * GAS_PRICE diverge
        // across validators → fork. Gas ceiling must match the gasCeiling in actions.js.
        const GAS_CEILING = 1000000;
        if(vmFailed && /^(timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(String(vmError))){
            gasUsed = GAS_CEILING;
        }

        // Recalculate fee based on actual gas used
        fee = this.util.bcmul(gasUsed, this.config['GAS_PRICE'], 8);

        // Determine final status
        let status = error ? error : (vmStatus || 'valid');
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
            ERROR_MESSAGE   : error || vmError || null,
            EMITTED_COUNT   : emittedCount,
            BLOCK_INDEX     : data['BLOCK_INDEX']
        });

        // Store the SOURCE and GAS tick in addresses list
        this.util.addAddressTicker(data['SOURCE'], gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Debit gas fee from SOURCE. Mirror the in-memory balance debit's condition
        // EXACTLY (!error && !skipFee && feePaymentMode === 2). A failed VM run (revert /
        // out_of_gas / timeout) leaves `error` null (it sets vmError + a dedicated vmStatus),
        // so the "caller pays for a failed attempt" case still debits. The source is known to
        // hold GAS credits here (it passed the pre-VM balance check), so the debit stays
        // ledger/balance-consistent even if it drives the balance negative. But an EXECUTE
        // rejected before the VM ran
        // (insufficient GAS funds / inactive contract / sleeping source) sets `error`
        // and must NOT record a ledger debit: burning gas the source never had drops
        // ledger supply while getAddressBalances (which only iterates credit ticks)
        // leaves the balances projection unchanged — balance = ledger + 1, SanityError.
        if(!error && !skipFee && tokenInfo && feePaymentMode === 2)
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

    /*****************************************************************
     * Emission Processing — Routes emitted actions to existing handlers
     ****************************************************************/

    async processEmission(emission, executionData, position){
        let action = emission.action;
        let params = emission.params;

        // ATTEST v0 (request) anchors its on-chain request_id to the emitter position, so the
        // handler can re-derive and verify it (defends against a compromised VM forging a
        // request_id). EMITTER_POSITION is therefore mandatory for ATTEST emissions — fail
        // loudly at the source if a caller ever omits it rather than letting the handler fall
        // back to accepting an unverified request_id.
        if(action === 'ATTEST' && (position === undefined || position === null))
            throw new Error('ATTEST emission missing EMITTER_POSITION (position argument)');

        // Force source to the contract's derived address
        let contractAddress = 'C:' + this.config['CHAIN'] + ':' + executionData['CONTRACT_ACTION_INDEX'];

        // Build positional params array for the handler
        let actionParams = this.buildActionParams(action, params);

        // Create a real action_index for this emission
        let emissionActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      action,
            BLOCK_INDEX: executionData['BLOCK_INDEX'],
            TX_INDEX:    executionData['TX_INDEX'],
            TX_VOUT:     executionData['TX_VOUT'],
            FORMAT:      0,
            // The emission's TRUE source is the contract, not the EXECUTE caller. Persisting it
            // here is what lets refunds/ownership/auth resolve back to the contract later.
            SOURCE:      contractAddress
        }, true);  // force=true to always create new

        // Build the data object that action handlers expect
        let emissionData = {
            ACTION_INDEX:       emissionActionIndex,
            SOURCE:             contractAddress,
            FEE_PAYER:          executionData['SOURCE'],
            BLOCK_INDEX:        executionData['BLOCK_INDEX'],
            BLOCK_TIME:         executionData['BLOCK_TIME'],
            TX_INDEX:           executionData['TX_INDEX'],
            TX_HASH:            executionData['TX_HASH'],
            TX_VOUT:            executionData['TX_VOUT'],
            FORMAT:             0,
            IS_EMISSION:        true,
            EMITTER:            executionData['CONTRACT_ACTION_INDEX'],
            EMITTER_POSITION:   position    // index within this EXECUTE's emission list — used by ATTEST v0 (request) to verify deterministic request_id
        };

        // Route to the correct handler
        let handler = this.getActionHandler(action);
        if(!handler)
            throw new Error('unknown emission action: ' + action);

        // Parse through the existing handler — same validation as user-submitted actions
        let emissionError = null;
        await handler.parse(actionParams, emissionData, emissionError);

        // Check handler result
        if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid')
            throw new Error(action + ': ' + emissionData['STATUS']);

        // Store the resulting action_index for the emission record
        emission.resultActionIndex = emissionData['ACTION_INDEX'];
    }

    // Map action names to handler instances
    getActionHandler(action){
        let handlers = {
            'SEND':       this.actions.actionSend,
            'DESTROY':    this.actions.actionDestroy,
            'ISSUE':      this.actions.actionIssue,
            'MINT':       this.actions.actionMint,
            'ORDER':      this.actions.actionOrder,
            'DISPENSER':  this.actions.actionDispenser,
            'DIVIDEND':   this.actions.actionDividend,
            'AIRDROP':    this.actions.actionAirdrop,
            'CALLBACK':   this.actions.actionCallback,
            'FILE':       this.actions.actionFile,
            'LIST':       this.actions.actionList,
            'COINPAY':    this.actions.actionCoinpay,
            'SWEEP':      this.actions.actionSweep,
            'LINK':       this.actions.actionLink,
            'BROADCAST':  this.actions.actionBroadcast,
            'MESSAGE':    this.actions.actionMessage,
            'ATTEST':     this.actions.actionAttest
        };
        return handlers[action] || null;
    }

    // Convert emission params object to positional array for each action type.
    // MUST match the format strings in each handler's this.formats[0].
    buildActionParams(action, params){
        switch(action){
            case 'SEND':
                // FORMAT: VERSION|TICK|AMOUNT|DESTINATION|MEMO
                return [0, params.tick, params.quantity, params.destination, params.memo || ''];
            case 'DESTROY':
                // FORMAT: VERSION|TICK|AMOUNT|MEMO
                return [0, params.tick, params.quantity, params.memo || ''];
            case 'ISSUE':
                // FORMAT: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
                return [0, params.tick, params.maxSupply || '', params.maxMint || '', params.decimals || '',
                        params.description || '', params.mintSupply || '', params.transfer || '', params.transferSupply || '',
                        params.lockMaxSupply || '', params.lockMaxMint || '', params.lockDescription || '',
                        params.lockSleep || '', params.lockCallback || '', params.callbackBlock || '',
                        params.callbackTick || '', params.callbackAmount || '', params.allowList || '',
                        params.blockList || '', params.mintAddressMax || '', params.mintStartBlock || '',
                        params.mintStopBlock || '', params.lockMint || '', params.lockMintSupply || '', params.memo || ''];
            case 'MINT':
                // FORMAT: VERSION|TICK|AMOUNT|DESTINATION|MEMO
                return [0, params.tick, params.quantity, params.destination || '', params.memo || ''];
            case 'ORDER':
                // FORMAT: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
                // GIVE_OWNERSHIP/GET_OWNERSHIP (token-ownership trading) default to 0 when empty.
                return [0, params.giveCoin || '', params.giveTick || '', params.giveAmount, params.giveOwnership || '',
                        params.getCoin || '', params.getTick || '', params.getAmount, params.getOwnership || '',
                        params.getAddress || '', params.expiration || '',
                        params.allowList || '', params.blockList || '', params.memo || ''];
            case 'DISPENSER':
                // FORMAT: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
                // GIVE_OWNERSHIP defaults to 0; ORACLE_ADDRESS (PRICE v1 oracle) is optional.
                return [0, params.giveCoin || '', params.giveTick || '', params.giveAmount, params.giveOwnership || '', params.giveEscrow,
                        params.getCoin || '', params.getTick || '', params.getAmount,
                        params.getAddress || '', params.fiatCode || '', params.fiatAmount || '', params.oracleAddress || '',
                        params.expiration || '', params.allowList || '', params.blockList || '', params.memo || ''];
            case 'DIVIDEND':
                // FORMAT: VERSION|TICK|DIVIDEND_TICK|AMOUNT|MEMO
                return [0, params.tick, params.dividendTick, params.quantity, params.memo || ''];
            case 'AIRDROP':
                // FORMAT: VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO
                return [0, params.tick, params.quantity, params.listActionIndex, params.memo || ''];
            case 'CALLBACK':
                // FORMAT: VERSION|TICK|MEMO
                return [0, params.tick, params.memo || ''];
            case 'FILE':
                // FORMAT: VERSION|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH
                // Trailing gated-file fields default to empty (public file); a contract may set
                // them to emit a token-gated FILE.
                return [0, params.name || '', params.type || '', params.title || '', params.memo || '',
                        params.gateTicker || '', params.encryptionMethod || '', params.keyHash || ''];
            case 'LIST':
                // FORMAT: VERSION|TYPE|ITEM
                return [0, params.type || '', params.item || ''];
            case 'COINPAY':
                // FORMAT: VERSION|ORDER_MATCH_ACTION_INDEX
                return [0, params.orderMatchActionIndex];
            case 'SWEEP':
                // FORMAT: VERSION|DESTINATION|BALANCES|OWNERSHIPS|ORDERS|SWAPS|DISPENSERS|MEMO
                return [0, params.destination, params.balances || '', params.ownerships || '', params.orders || '', params.swaps || '', params.dispensers || '', params.memo || ''];
            case 'LINK':
                // FORMAT: VERSION|COIN1|COIN1_ACTION_INDEX|COIN2|COIN2_ACTION_INDEX|MEMO
                return [0, params.coin1, params.coin1ActionIndex, params.coin2, params.coin2ActionIndex, params.memo || ''];
            case 'BROADCAST':
                // FORMAT: VERSION|MESSAGE|VALUE
                return [0, params.message || '', params.value || ''];
            case 'MESSAGE':
                // FORMAT: VERSION|COIN|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY
                // COIN (destination network) is optional — empty = unscoped. Without it the
                // DESTINATION would land in the COIN slot and the message would be malformed.
                return [0, params.coin || '', params.destination, params.encryptionMethod || '', params.encryptionKey || ''];
            case 'ATTEST':
                // FORMAT v0 (request, VM-emitted): VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS
                return [0, params.requestId, params.providerId, params.requestPayload, params.callbackMethod,
                        params.callbackParams || '[]', params.redundancy, params.deadlineBlocks];
            default:
                throw new Error('unsupported emission action: ' + action);
        }
    }

    // Process a SLASH emission from inside the VM. The emission carries:
    //   { action: 'SLASH', params: { contractIndex, pubkey, token, amount } }
    // Authorization is implicit — the gateway's contractStakeData accessor is scoped
    // to the executing contract, so SLASH can only target stakes against that contract.
    // We still defense-in-depth verify contractIndex matches data['CONTRACT_ACTION_INDEX'].
    //
    // Side effects (all inside the surrounding vm_execute savepoint):
    //   1. Deduct `amount` from contract_stakes (LIFO) then contract_unstakes.
    //   2. Credit the slashed amount to contracts.slash_destination_id (BURN or configured).
    //   3. Write a slash_events row keyed by execution_index for audit + wallet UX.
    async _processSlashEmission(emission, data){
        let p = emission.params || {};
        let contractIndex = Number(p.contractIndex);
        let pubkey        = String(p.pubkey || '').toLowerCase();
        let token         = String(p.token || '');
        let amount        = String(p.amount || '0');

        // Defense in depth — caller mismatch should never happen if the gateway
        // closure is sourced correctly, but throw if it does (rolls back the savepoint).
        if(contractIndex !== Number(data['CONTRACT_ACTION_INDEX']))
            throw new Error('SLASH emission contractIndex mismatch: ' + contractIndex + ' vs ' + data['CONTRACT_ACTION_INDEX']);

        // Load contract row to fetch slash_destination_id (locked at DEPLOY time)
        let contractInfo = await this.indexerDb.getContract(contractIndex);
        if(!contractInfo)
            throw new Error('SLASH: contract not found: ' + contractIndex);
        if(contractInfo.slash_destination_id === null || contractInfo.slash_destination_id === undefined)
            throw new Error('SLASH: contract has no slash destination configured');

        // Resolve FKs
        let pubkeyId = await this.indexerDb.getPubkeyId(pubkey);
        if(pubkeyId === null) return; // pubkey not staked here — nothing to slash, silent no-op
        let tickId = await this.indexerDb.getTickerId(token);
        if(tickId === null) return;

        // Deduct (returns actual slashed total — may be less than requested if balance lower)
        let slashed = await this.indexerDb.slashContractStake(contractIndex, pubkeyId, tickId, amount);
        if(!this.util.bcgt(slashed, '0')) return;

        // Credit destination address (BURN or user-specified)
        let destQ = await this.indexerDb.doQuery(
            'SELECT address FROM index_addresses WHERE id=? LIMIT 1',
            [contractInfo.slash_destination_id]
        );
        if(destQ.length === 0)
            throw new Error('SLASH: destination address row missing');
        let destAddress = destQ[0].address;

        // Write credit row (action_index = the EXECUTE's action_index, for audit trail)
        await this.indexerDb.createCredit(data['ACTION_INDEX'], token, slashed, destAddress);

        // Track destination + token for balance reconciliation in the surrounding execute()
        this.util.addAddressTicker(destAddress, token);

        // Write the slash event row
        await this.indexerDb.createSlashEvent({
            EXECUTION_INDEX:       data['ACTION_INDEX'],
            TARGET_CONTRACT_INDEX: contractIndex,
            SIGNING_PUBKEY_ID:     pubkeyId,
            TICK_ID:               tickId,
            AMOUNT:                slashed,
            DESTINATION_ID:        contractInfo.slash_destination_id,
            BLOCK_INDEX:           data['BLOCK_INDEX']
        });
    }
}

module.exports = Execute;

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
 * XChain Platform Action - SWAP
 * 
 * This action allows for swapping tokens across XChain platform supported blockchains.
 * 
 * PARAMS:
 * - VERSION           -  Format Version
 * - GIVE_COIN         -  `COIN` name (BTC, LTC, DOGE, etc)
 * - GIVE_TICK         -  Ticker name or Ticker ID
 * - GIVE_AMOUNT       -  Quantity of `GIVE_TICK` to escrow in the swap (empty when GIVE_OWNERSHIP=1)
 * - GIVE_OWNERSHIP    -  1 = escrow GIVE_TICK ownership instead of a balance amount (default 0)
 * - GET_COIN          -  `COIN` name (BTC, LTC, DOGE, etc)
 * - GET_TICK          -  Ticker name or Ticker ID
 * - GET_AMOUNT        -  Quantity of `GET_TICK` requested in return (empty when GET_OWNERSHIP=1)
 * - GET_OWNERSHIP     -  1 = require matcher to currently own GET_TICK and transfer it (default 0)
 * - GET_ADDRESS       -  Address to receive `GET_TICK` on `GET_COIN` network
 * - EXPIRATION        -  Timestamp of when swap should expire, in Unix time
 * - ALLOW_LIST        - `ACTION_INDEX` of a `LIST` of addresses allowed to match swap
 * - BLOCK_LIST        - `ACTION_INDEX` of a `LIST` of addresses NOT allowed to match swap
 * - MEMO              -  An optional memo to include
 * - SWAP_ACTION_INDEX -  `ACTION_INDEX` of existing `SWAP`
 * 
 * FORMATS:
 * - 0 = Create Swap
 * - 1 = Cancel Swap
 * - 2 = Edit Swap
 *
 ********************************************************************/

class Swap {

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
        this.formats[0] = 'VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';
        this.formats[1] = 'VERSION|SWAP_ACTION_INDEX|MEMO';
        this.formats[2] = 'VERSION|SWAP_ACTION_INDEX|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';

        // Define array of acceptable list types (2=Address)
        this.listTypes = [2];
    }

    // Handle parsing the SWAP transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str    = "0|JDOG|1|";
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        if(!error)
            data = this.util.setNumberFormats(data);

        // Resolve a compacted ^<id> GET_ADDRESS back to its canonical address
        // before the default-to-SOURCE and validation logic (see resolveAddressRef);
        // non-resolvable or malformed references are left as-is and rejected by
        // isCryptoAddress.
        if(!error)
            data['GET_ADDRESS'] = await this.indexerDb.resolveAddressRef(data['GET_ADDRESS']);

        // Get information on the GIVE and GET tokens
        let giveTokenInfo = false;
        let getTokenInfo  = false;
        if(format==0){
            giveTokenInfo = await this.indexerDb.getTokenInfo(data['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(data['GET_COIN']==this.config['COIN']){
                getTokenInfo = await this.indexerDb.getTokenInfo(data['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            }
            // (Cross-chain GET_TICK lives on another COIN network; it cannot be validated
            //  locally. The xchain-hub federation validates it before matching/settlement.)
        }

        // Detect a cross-chain swap (GET side settles on a different COIN network). The GIVE
        // side still escrows locally; matching + settlement are driven by the validator
        // federation (mirror-delivered cross-chain match) rather than the local SWAP_MATCH path.
        let isCrossChain      = (format==0 && !this.util.isNull(data['GET_COIN']) && data['GET_COIN']!=this.config['COIN']);
        let crossChainEnabled = isCrossChain ? await this.actions.protocolChanges.isEnabled('CROSS_CHAIN_DEX', data['BLOCK_INDEX']) : false;

        // Default ownership flags to 0 when omitted; coerce to Number for downstream comparisons
        if(format==0){
            data['GIVE_OWNERSHIP'] = this.util.isNull(data['GIVE_OWNERSHIP']) ? 0 : Number(data['GIVE_OWNERSHIP']);
            data['GET_OWNERSHIP']  = this.util.isNull(data['GET_OWNERSHIP'])  ? 0 : Number(data['GET_OWNERSHIP']);
        }
        let isOwnershipGive = (format==0 && data['GIVE_OWNERSHIP']==1);
        let isOwnershipGet  = (format==0 && data['GET_OWNERSHIP']==1);

        // Get information on the swap by its action_index. Pass null coin (not the local
        // COIN): cancel/edit must locate the swap regardless of its get_coin, or a
        // cross-chain swap (whose get_coin is the counterparty chain) is never found.
        var swapInfo = false;
        if(format==1 || format==2)
            swapInfo = await this.indexerDb.getSwapInfo(null, data['SWAP_ACTION_INDEX'])

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // Default GET_ADDRESS to SOURCE address if COIN networks are the same and GET_ADDRESS is not given
        if(this.config['COIN']==data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            data['GET_ADDRESS'] = data['SOURCE'];

        // Set EXPIRATION value if none is given
        if(format==0 && this.util.isNull(data['EXPIRATION']))
            data['EXPIRATION'] = this.util.getDefaultExpiration(data['BLOCK_TIME']);

        // Clone the raw data for storage in swap table
        let swap = Object.assign({}, data);

        /*****************************************************************
         * TICK & COIN Validations
         ****************************************************************/

        // Validate GIVE_COIN is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['GIVE_COIN']))
            error = 'invalid: GIVE_COIN (unsupported COIN network)';

        // Validate GET_COIN is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['GET_COIN']))
            error = 'invalid: GET_COIN (unsupported COIN network)';

        // validate GIVE_COIN network is current COIN network
        if(!error && format==0 && this.config['COIN']!=data['GIVE_COIN'])
            error = "invalid: GIVE_COIN (network)";

        // Validate GIVE_TICK exists
        if(!error && format==0 && !giveTokenInfo)
            error = 'invalid: GIVE_TICK (unknown)';

        // Cross-chain swaps require the CROSS_CHAIN_DEX protocol change to be active
        if(!error && isCrossChain && !crossChainEnabled)
            error = 'invalid: GET_COIN (cross-chain not enabled)';

        // Validate GET_TICK exists (local validation only; a cross-chain GET_TICK is
        // validated by the xchain-hub federation, so skip the local existence check)
        if(!error && format==0 && !isCrossChain && !getTokenInfo)
            error = 'invalid: GET_TICK (unknown)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify GIVE_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GIVE_AMOUNT']) && giveTokenInfo && !this.util.isValidAmountFormat(giveTokenInfo['DECIMALS'], data['GIVE_AMOUNT']))
            error = "invalid: GIVE_AMOUNT (format)";

        // Verify GET_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GET_AMOUNT']) && getTokenInfo && !this.util.isValidAmountFormat(getTokenInfo['DECIMALS'], data['GET_AMOUNT']))
            error = "invalid: GET_AMOUNT (format)";

        // Verify GET_ADDRESS is given if COIN network differs from GET_COIN network
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            error = "invalid: GET_ADDRESS";

        // Verify GET_ADDRESS is valid for the given GET_COIN network
        if(!error && format==0 && !this.util.isNull(data['GET_ADDRESS']) && !this.util.isCryptoAddress(data['GET_ADDRESS'], data['GET_COIN']))
            error = "invalid: GET_ADDRESS (format)";

        // Validate that EXPIRATION is an integer
        if(!error && !this.util.isNull(data['EXPIRATION']) && (!this.util.isNumeric(data['EXPIRATION']) || !this.util.isInteger(data['EXPIRATION'])))
            error = "invalid: EXPIRATION (format)";

        /*****************************************************************
         * Token Ownership Validations (format 0 only)
         ****************************************************************/

        // GIVE_OWNERSHIP / GET_OWNERSHIP must be 0 or 1
        if(!error && format==0 && ![0,1].includes(data['GIVE_OWNERSHIP']))
            error = "invalid: GIVE_OWNERSHIP (format)";
        if(!error && format==0 && ![0,1].includes(data['GET_OWNERSHIP']))
            error = "invalid: GET_OWNERSHIP (format)";

        // Selling ownership: GIVE_AMOUNT must be empty, GIVE_TICK must be a known tick,
        // SOURCE must currently own it, and the tick's ownership must not already be escrowed.
        if(!error && isOwnershipGive){
            if(!this.util.isNull(data['GIVE_AMOUNT']))
                error = "invalid: GIVE_AMOUNT (must be empty when GIVE_OWNERSHIP=1)";
            else if(!giveTokenInfo)
                error = "invalid: GIVE_TICK (unknown)";
            else if(giveTokenInfo['OWNER'] != data['SOURCE'])
                error = "invalid: SOURCE (not GIVE_TICK owner)";
            else if(await this.indexerDb.isOwnershipEscrowed(data['GIVE_TICK']))
                error = "invalid: GIVE_TICK (ownership already escrowed)";
        }

        // Bidding for ownership: GET_AMOUNT must be empty. GET_TICK existence is only verifiable
        // on the current chain; cross-chain GET_TICK validation lives in xchain-hub.
        if(!error && isOwnershipGet){
            if(!this.util.isNull(data['GET_AMOUNT']))
                error = "invalid: GET_AMOUNT (must be empty when GET_OWNERSHIP=1)";
            else if(data['GET_COIN']==this.config['COIN'] && !getTokenInfo)
                error = "invalid: GET_TICK (unknown)";
        }

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is not sleeping
        if(!error && format==0 && await this.indexerDb.isActionAllowed(null, data['GIVE_TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: TICK (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // Verify TICK action is allowed from SOURCE (allow/block lists)
        if(!error && format==0 && await this.indexerDb.isActionAllowed(data['SOURCE'], data['GIVE_TICK']) == false)
            error = 'invalid: SOURCE (not authorized)';

        // Validate SWAP_ACTION_INDEX is valid SWAP
        if(!error && (format==1 || format==2) && !swapInfo)
            error = 'invalid: SWAP_ACTION_INDEX (unknown)';

        // Verify SOURCE address is owner of the SWAP_ACTION_INDEX swap
        if(!error && (format==1 || format==2) && data['SOURCE']!=swapInfo['SOURCE'])
            error = 'invalid: SOURCE (not owner)';

        // Validate SWAP_ACTION_INDEX is valid SWAP with a status of open
        if(!error && (format==1 || format==2) && swapInfo['SWAP_STATUS']!='open')
            error = 'invalid: SWAP_ACTION_INDEX (swap not open)';

        // Validate that EXPIRATION is greater than current BLOCK_TIME
        if(!error && !this.util.isNull(data['EXPIRATION']) && this.util.bclte(data['EXPIRATION'], data['BLOCK_TIME']))
            error = "invalid: EXPIRATION (past)";

        // Validate LIST fields (ALLOW_LIST / BLOCK_LIST)
        if(!error){
            for(let name of this.config['LIST_FIELDS']){
                if(!error && !this.util.isNull(data[name]) && this.util.isNumeric(data[name])){
                    // Get LIST type and information
                    let type = await this.indexerDb.getListType(data[name]);

                    // Verify LIST exist
                    if(!error && type===false)
                        error = 'invalid: ' + name + ' (unknown)';

                    // Verify LIST type is supported
                    if(!error && !this.listTypes.includes(type))
                        error = 'invalid: ' + name + ' (unsupported)';
                }
            }
        }

        // Verify SOURCE has enough balances to cover GIVE_AMOUNT (skip for ownership; no balance to escrow)
        if(!error && format==0 && !isOwnershipGive && !this.util.hasBalance(balances, giveTokenInfo['TICK_ID'], data['GIVE_AMOUNT']))
            error = 'invalid: insufficient funds (GIVE_AMOUNT)';

        // Adjust balances to reduce by SWAP GIVE_AMOUNT (skip for ownership)
        if(!error && format==0 && !isOwnershipGive)
            balances = this.util.debitBalances(balances, giveTokenInfo['TICK_ID'], data['GIVE_AMOUNT']);

        // Calculate total fee for this swap: expiration + ownership-escrow premium (create only)
        fees['AMOUNT'] = 0;

        if(!error && (format==0 || format==2)){
            let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
            if(unifiedFees){
                let gasCost = 0;
                let fee     = 0;
                if(!this.util.isNull(data['EXPIRATION'])){
                    let exp = this.util.getUnifiedExpirationFee(data, swapInfo);
                    gasCost = this.util.bcadd(gasCost, exp.gasCost, 0);
                    fee     = this.util.bcadd(fee, exp.fee, 8);
                }
                if(format==0 && isOwnershipGive){
                    let own = this.util.getOwnershipEscrowFee();
                    gasCost = this.util.bcadd(gasCost, own.gasCost, 0);
                    fee     = this.util.bcadd(fee, own.fee, 8);
                }
                fees['GAS_COST']    = gasCost;
                fees['AMOUNT']      = fee;
                fees['FEE_VERSION'] = 2;
            } else if(!this.util.isNull(data['EXPIRATION'])){
                fees['AMOUNT'] = this.util.getExpirationFee(data, swapInfo);
            }
        }

        // Validate fee payment (native coin or XCHAIN balance)
        if(!error && this.util.bcgt(fees['AMOUNT'], 0)){
            let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(paymentMode === 'native'){
                let validation = await this.util.validateNativeCoinFee(data, fees, this.indexerDb, data['TX_OUTPUTS']);
                if(!validation.valid){
                    error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                } else {
                    fees['PAYMENT_MODE']       = 1;
                    fees['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                    fees['NATIVE_COIN']        = validation.nativeCoin;
                    fees['ORACLE_ROUND']       = validation.oracleRound;
                }
            } else if(paymentMode === 'rejected'){
                error = 'invalid: insufficient fee (native coin output required)';
            } else {
                if(!this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                    error = 'invalid: insufficient funds (FEE)';
            }
        }

        // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // Controller-bound GIVE token: the bound contract's `guard` must approve
        // LISTING this token for sale before the swap opens. Veto-only at create
        // (no proceeds yet); the royalty cut is taken at match (swap_match.js).
        // SOURCE pays the bounded guard gas (reserved up front).
        let guardFee = 0;
        if(!error && format==0 && giveTokenInfo){
            let gasInfo = await this.indexerDb.getTokenInfo(this.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let result  = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                actionType:   'SWAP_CREATE',
                tick:         data['GIVE_TICK'],
                from:         data['SOURCE'],
                to:           '',
                amount:       isOwnershipGive ? '' : data['GIVE_AMOUNT'],
                price:        data['GET_AMOUNT'],
                proceedsTick: data['GET_TICK'],
                data:         data,
                gasInfo:      gasInfo,
                gasBalances:  balances
            });
            if(result.error){
                error = 'invalid: ' + result.error;
            } else {
                guardFee = result.guardFee;
                // Persist the guard's royalty/fee split (bps legs) on the swap row; the protocol
                // applies it to the seller's proceeds at match (Utility.applyProceedsSplit).
                // NB: `swap` was snapshotted (Object.assign) before the guard ran, and createSwap
                // persists `swap`, so set the legs on BOTH or they never reach the DB.
                if(result.payoutLegs)
                    data['PAYOUT_LEGS'] = swap['PAYOUT_LEGS'] = JSON.stringify(result.payoutLegs);
            }
        }

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = swap['STATUS'] = status;

        // Set SWAP status to 'open' when creating a valid swap
        swap['SWAP_STATUS'] = (status=='valid') ? 'open' : 'invalid';

        // Print status message
        if(format==0)
            console.log("\t SWAP : " + data['GIVE_AMOUNT'] + ' ' + this.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  data['GET_AMOUNT'] + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);
        if(format==1)
            console.log("\t SWAP_CANCEL : " + this.config['COIN'] + ':' + data['SWAP_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==2)
            console.log("\t SWAP_EDIT : " + this.config['COIN'] + ':' + data['SWAP_ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Create record in swaps table
        if(format==0)
            await this.indexerDb.createSwap(swap);

        // Update action from SWAP to SWAP_CANCEL and create record in swap_cancels table
        if(format==1){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'SWAP_CANCEL');
            await this.indexerDb.createSwapCancel(swap);
        }

        // Update action from SWAP to SWAP_EDIT and create record in swap_edits table
        if(format==2){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'SWAP_EDIT');
            await this.indexerDb.createSwapEdit(swap);
        }

        // Store the SOURCE, GIVE_TICK, and GET_TICK in addresses list
        if(format==0){
            this.util.addAddressTicker(data['SOURCE'], [data['GIVE_TICK'], data['GET_TICK']]);
        } else if(swapInfo) {
            this.util.addAddressTicker(swapInfo['SOURCE'], [swapInfo['GIVE_TICK'], swapInfo['GET_TICK']]);
        }

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // If this was a valid transaction, add GIVE_AMOUNT to escrow
        if(status=='valid'){

            // If we are charging a fee, store the SOURCE and fees TICK in addresses list
            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Format 0 - Create Swap
            if(format==0){
                if(isOwnershipGive){
                    // Selling ownership: no balance escrow. Mark the tick as ownership-escrowed
                    // for this swap. tokens.owner_id stays at SOURCE; admin actions are gated by
                    // escrow_action_index until cancel / expire / match clears it.
                    await this.indexerDb.setTokenEscrow(data['GIVE_TICK'], data['ACTION_INDEX']);
                } else {
                    // Debit token from SOURCE
                    debits.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);

                    // Escrow token from SOURCE
                    escrows.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);
                }

                // Create record in the swaps_statuses table
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');
            }

            // Format 1 - Cancel Swap
            if(format==1){
                if(swapInfo['GIVE_OWNERSHIP']==1){
                    // Release ownership escrow back to the seller (tokens.owner_id is unchanged)
                    await this.indexerDb.clearTokenEscrow(swapInfo['GIVE_TICK']);
                } else {
                    // Debit token from escrows
                    escrows.push([swapInfo['GIVE_TICK'],  -swapInfo['GIVE_AMOUNT'],  swapInfo['SOURCE']]);

                    // Credit token to SOURCE
                    credits.push([swapInfo['GIVE_TICK'], swapInfo['GIVE_AMOUNT'], swapInfo['SOURCE']]);
                }

                // Create record in the swaps_statuses table
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], swapInfo['ACTION_INDEX'], 'cancelled');
            }

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

        }

        // Create action mappings
        await this.mapper.createMappings(data);

        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        // Check to see if we have a match for this swap.
        // Cross-chain swaps are NOT matched locally; the counterparty lives in another
        // chain's indexer DB, invisible to the local SWAP_MATCH query. The xchain-hub
        // federation matches them and delivers a validator-signed match via the hub mirror,
        // which the indexer settles from escrow (see the cross-chain settlement pass).
        if(status=='valid' && !isCrossChain)
            await this.actions.processAction('SWAP_MATCH', null, data, null);

    }
}

module.exports = Swap;
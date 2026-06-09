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
 * XChain Platform Action - ORDER
 * 
 * This action creates a order to sell an item on the Decentralized Exchange (DEX).
 * 
 * PARAMS:
 * VERSION             - Format Version
 * GIVE_COIN           - `COIN` name (BTC, LTC, DOGE, etc)
 * GIVE_TICK           - Ticker name or Ticker ID
 * GIVE_AMOUNT         - Quantity of `GIVE_TICK` to escrow in the order (empty when GIVE_OWNERSHIP=1)
 * GIVE_OWNERSHIP      - 1 = escrow GIVE_TICK ownership instead of a balance amount (default 0)
 * GET_COIN            - `COIN` name (BTC, LTC, DOGE, etc)
 * GET_TICK            - Ticker name or Ticker ID
 * GET_AMOUNT          - Quantity of `GET_TICK` requested in return (empty when GET_OWNERSHIP=1)
 * GET_OWNERSHIP       - 1 = require matcher to currently own GET_TICK and transfer it (default 0)
 * GET_ADDRESS         - Address to receive `GET_TICK` on `GET_COIN` network
 * EXPIRATION          - Timestamp of when order should expire, in Unix time
 * ALLOW_LIST          - `ACTION_INDEX` of a `LIST` of addresses allowed to match order
 * BLOCK_LIST          - `ACTION_INDEX` of a `LIST` of addresses NOT allowed to match order
 * MEMO                - An optional memo to include
 * ORDER_ACTION_INDEX  - `ACTION_INDEX` of existing `ORDER`
 * 
 * FORMATS:
 * - 0 = Create Order
 * - 1 = Cancel Order
 * - 2 = Edit Order
 *
 ********************************************************************/

class Order {

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
        this.formats[1] = 'VERSION|ORDER_ACTION_INDEX|MEMO';
        this.formats[2] = 'VERSION|ORDER_ACTION_INDEX|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';

        // Define array of supported list types (1=Tick, 2=Address)
        this.listTypes = [2];
    }

    // Handle parsing the ORDER transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str    = "0|BTC|RAREPEPE|1|BTC|PEPECASH|10000000.00000000|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|||Selling my RAREPEPE cuz mom in hospital";
        // let str    = "1|1234|Closing order, no buyers, much disappoint";
        // let str    = "2|1234|4321|||Updating order to only sell to club member addresses";
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

        // Detect native coin sides (null/empty TICK = native coin on that chain)
        let isNativeCoinGive = (format==0) ? this.util.isNull(data['GIVE_TICK']) : false;
        let isNativeCoinGet  = (format==0) ? this.util.isNull(data['GET_TICK'])  : false;

        // Default ownership flags to 0 when omitted; coerce to Number for downstream comparisons
        if(format==0){
            data['GIVE_OWNERSHIP'] = this.util.isNull(data['GIVE_OWNERSHIP']) ? 0 : Number(data['GIVE_OWNERSHIP']);
            data['GET_OWNERSHIP']  = this.util.isNull(data['GET_OWNERSHIP'])  ? 0 : Number(data['GET_OWNERSHIP']);
        }
        let isOwnershipGive = (format==0 && data['GIVE_OWNERSHIP']==1);
        let isOwnershipGet  = (format==0 && data['GET_OWNERSHIP']==1);

        // Detect a cross-chain order (GET side settles on a different COIN network). The GIVE
        // side still escrows locally; matching + settlement are driven by the validator
        // federation (mirror-delivered cross-chain fill) rather than the local ORDER_MATCH path.
        let isCrossChain      = (format==0 && !this.util.isNull(data['GET_COIN']) && data['GET_COIN']!=this.config['COIN']);
        let crossChainEnabled = isCrossChain ? await this.actions.protocolChanges.isEnabled('CROSS_CHAIN_DEX', data['BLOCK_INDEX']) : false;

        // Get information on the GIVE and GET tokens (skip for native coin sides)
        let giveTokenInfo = false;
        let getTokenInfo  = false;
        if(format==0){
            if(!isNativeCoinGive)
                giveTokenInfo = await this.indexerDb.getTokenInfo(data['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(!isNativeCoinGet && data['GET_COIN']==this.config['COIN']){
                getTokenInfo = await this.indexerDb.getTokenInfo(data['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            } else if(!isNativeCoinGet) {
                // TODO : add code to xchain-hub to validate that GET_TICK is valid on GET_COIN, and if not, mark as invalid
            }
        }

        // Get information on the order by its action_index. Pass null coin (not the local
        // COIN): cancel/edit must locate the order regardless of its get_coin, or a
        // cross-chain order (whose get_coin is the counterparty chain) is never found.
        var orderInfo = false;
        if(format==1 || format==2)
            orderInfo = await this.indexerDb.getOrderInfo(null, data['ORDER_ACTION_INDEX'])

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

        // Clone the raw data for storage in orders table
        let order = Object.assign({}, data);

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

        // Cross-chain orders (GET on another COIN network) require the CROSS_CHAIN_DEX
        // protocol change. GET_COIN itself is validated above; the xchain-hub federation
        // validates the cross GET_TICK and matches + settles the cross leg.
        if(!error && isCrossChain && !crossChainEnabled)
            error = "invalid: GET_COIN (cross-chain not enabled)";

        // Validate that both sides are not native coin (coin-for-coin is just a regular tx)
        if(!error && format==0 && isNativeCoinGive && isNativeCoinGet)
            error = 'invalid: cannot trade native coin for native coin';

        // Validate GIVE_TICK exists (skip for native coin — no token to validate)
        if(!error && format==0 && !isNativeCoinGive && !giveTokenInfo)
            error = 'invalid: GIVE_TICK (unknown)';

        // Validate GET_TICK exists (skip for native coin — no token to validate — and for
        // cross-chain, where GET_TICK lives on another COIN network and is validated by the
        // xchain-hub federation, not locally)
        if(!error && format==0 && !isNativeCoinGet && !isCrossChain && !getTokenInfo)
            error = 'invalid: GET_TICK (unknown)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify GIVE_AMOUNT format (use COIN_DECIMALS for native coin, token DECIMALS for tokens)
        let giveDecimals = isNativeCoinGive ? this.config['COIN_DECIMALS'] : (giveTokenInfo ? giveTokenInfo['DECIMALS'] : 0);
        if(!error && format==0 && !this.util.isNull(data['GIVE_AMOUNT']) && !this.util.isValidAmountFormat(giveDecimals, data['GIVE_AMOUNT']))
            error = "invalid: GIVE_AMOUNT (format)";

        // Verify GET_AMOUNT format (use COIN_DECIMALS for native coin, token DECIMALS for
        // tokens). Skip for cross-chain: the GET token's DECIMALS live on another COIN
        // network, so the format is validated by the xchain-hub federation, not locally.
        let getDecimals = isNativeCoinGet ? this.config['COIN_DECIMALS'] : (getTokenInfo ? getTokenInfo['DECIMALS'] : 0);
        if(!error && format==0 && !isCrossChain && !this.util.isNull(data['GET_AMOUNT']) && !this.util.isValidAmountFormat(getDecimals, data['GET_AMOUNT']))
            error = "invalid: GET_AMOUNT (format)";

        // Verify GET_ADDRESS is given if COIN network differs from GET_COIN network
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            error = "invalid: GET_ADDRESS";

        // Verify GET_ADDRESS is valid for the given GET_COIN network.
        // A contract's derived address (C:CHAIN:N) is accepted ONLY when the GET side is a
        // token (not native coin): token proceeds settle on the XChain ledger (order_match
        // instant settlement) and a contract is a valid balance holder. A contract cannot
        // receive native coin at a synthetic address, so reject it for a native-coin GET.
        if(!error && format==0 && !this.util.isNull(data['GET_ADDRESS']) && !this.util.isCryptoAddress(data['GET_ADDRESS'])){
            if(!this.util.isContractAddress(data['GET_ADDRESS']))
                error = "invalid: GET_ADDRESS (format)";
            else if(isNativeCoinGet)
                error = "invalid: GET_ADDRESS (contract cannot receive native coin)";
        }

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

        // When selling ownership: GIVE_AMOUNT must be empty, GIVE_TICK must be a real tick (no native coin),
        // SOURCE must be the current owner, and the tick's ownership must not already be escrowed.
        if(!error && isOwnershipGive){
            if(!this.util.isNull(data['GIVE_AMOUNT']))
                error = "invalid: GIVE_AMOUNT (must be empty when GIVE_OWNERSHIP=1)";
            else if(isNativeCoinGive)
                error = "invalid: GIVE_TICK (native coin has no ownership)";
            else if(!giveTokenInfo)
                error = "invalid: GIVE_TICK (unknown)";
            else if(giveTokenInfo['OWNER'] != data['SOURCE'])
                error = "invalid: SOURCE (not GIVE_TICK owner)";
            else if(await this.indexerDb.isOwnershipEscrowed(data['GIVE_TICK']))
                error = "invalid: GIVE_TICK (ownership already escrowed)";
        }

        // When bidding for ownership: GET_AMOUNT must be empty and GET_TICK must be a real tick.
        // The matcher's-current-owner check happens at match time (order_match.js).
        if(!error && isOwnershipGet){
            if(!this.util.isNull(data['GET_AMOUNT']))
                error = "invalid: GET_AMOUNT (must be empty when GET_OWNERSHIP=1)";
            else if(isNativeCoinGet)
                error = "invalid: GET_TICK (native coin has no ownership)";
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

        // Verify TICK action is allowed from SOURCE (allow/block lists) — skip for native coin
        if(!error && format==0 && !isNativeCoinGive && await this.indexerDb.isActionAllowed(data['SOURCE'], data['GIVE_TICK']) == false)
            error = 'invalid: SOURCE (not authorized)';

        // Validate ORDER_ACTION_INDEX is valid SWAP
        if(!error && (format==1 || format==2) && !orderInfo)
            error = 'invalid: ORDER_ACTION_INDEX (unknown)';

        // Verify SOURCE address is owner of the ORDER_ACTION_INDEX order
        if(!error && (format==1 || format==2) && data['SOURCE']!=orderInfo['SOURCE'])
            error = 'invalid: SOURCE (not owner)';

        // Validate ORDER_ACTION_INDEX is valid ORDER with a status of open
        if(!error && (format==1 || format==2) && orderInfo['ORDER_STATUS']!='open')
            error = 'invalid: ORDER_ACTION_INDEX (order not open)';

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

        // Verify SOURCE has enough balances to cover GIVE_AMOUNT (skip for native coin and ownership — no balance to escrow)
        if(!error && format==0 && !isNativeCoinGive && !isOwnershipGive && !this.util.hasBalance(balances, giveTokenInfo['TICK_ID'], data['GIVE_AMOUNT']))
            error = 'invalid: insufficient funds (GIVE_AMOUNT)';

        // Adjust balances to reduce by ORDER GIVE_AMOUNT (skip for native coin and ownership)
        if(!error && format==0 && !isNativeCoinGive && !isOwnershipGive)
            balances = this.util.debitBalances(balances, giveTokenInfo['TICK_ID'], data['GIVE_AMOUNT']);

        // Calculate total fee for this order — expiration + ownership-escrow premium (create only)
        fees['AMOUNT'] = 0;

        if(!error && (format==0 || format==2)){
            let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
            if(unifiedFees){
                let gasCost = 0;
                let fee     = 0;
                if(!this.util.isNull(data['EXPIRATION'])){
                    let exp = this.util.getUnifiedExpirationFee(data, orderInfo);
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
                fees['AMOUNT'] = this.util.getExpirationFee(data, orderInfo);
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

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = order['STATUS'] = status;

        // Set ORDER status to 'open' when creating a valid order
        order['ORDER_STATUS'] = (status=='valid') ? 'open' : 'invalid';

        // Print status message
        if(format==0)
            console.log("\t ORDER : " + data['GIVE_AMOUNT'] + ' ' + this.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  data['GET_AMOUNT'] + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);
        if(format==1)
            console.log("\t ORDER_CANCEL : " + this.config['COIN'] + ':' + data['ORDER_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==2)
            console.log("\t ORDER_EDIT: " + this.config['COIN'] + ':' + data['ORDER_ACTION_INDEX'] + ' : ' + data['STATUS']);
 
        // Create record in orders table
        if(format==0)
            await this.indexerDb.createOrder(order);

        // Update action from ORDER to ORDER_CANCEL and create record in order_cancels table
        if(format==1){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'ORDER_CANCEL');
            await this.indexerDb.createOrderCancel(order);
        }

        // Update action from ORDER to ORDER_EDIT and create record in order_edits table
        if(format==2){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'ORDER_EDIT');
            await this.indexerDb.createOrderEdit(order);
        }

        // Store the SOURCE, GIVE_TICK, and GET_TICK in addresses list
        if(format==0){
            this.util.addAddressTicker(data['SOURCE'], [data['GIVE_TICK'], data['GET_TICK']]);
        } else if(orderInfo) {
            this.util.addAddressTicker(orderInfo['SOURCE'], [orderInfo['GIVE_TICK'], orderInfo['GET_TICK']]);
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

            // Format 0 - Create Order
            if(format==0){
                if(isOwnershipGive){
                    // Selling ownership: no balance escrow — mark the tick as ownership-escrowed
                    // for this order. tokens.owner_id stays at SOURCE; admin actions are gated by
                    // escrow_action_index until cancel / expire / match clears it.
                    await this.indexerDb.setTokenEscrow(data['GIVE_TICK'], data['ACTION_INDEX']);
                } else if(!isNativeCoinGive){
                    // Debit and escrow GIVE_AMOUNT of GIVE_TICK from SOURCE
                    debits.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);
                    escrows.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);
                }
                // (Native coin GIVE: no escrow — obligation created at match time via COINPay)

                // Create record in the orders_statuses table
                await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');
            }

            // Format 1 - Cancel Order
            if(format==1){

                // Check for pending COINPay obligations before cancelling
                let pendingObligations = await this.indexerDb.getPendingCoinpayObligationsByOrder(orderInfo['ACTION_INDEX']);

                if(pendingObligations.length > 0){
                    // Two-phase cancel: set status to 'cancelling' — blocks new matches, pending obligations must resolve first
                    // Ownership escrow stays set; coinpay.js will release it when the final obligation resolves.
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'cancelling');
                } else {
                    // No pending obligations — cancel immediately
                    if(orderInfo['GIVE_OWNERSHIP']==1){
                        // Release ownership escrow back to the seller (tokens.owner_id is unchanged — only the gate clears)
                        await this.indexerDb.clearTokenEscrow(orderInfo['GIVE_TICK']);
                    } else if(!this.util.isNull(orderInfo['GIVE_TICK'])){
                        // Debit token from escrows and credit back to seller
                        escrows.push([orderInfo['GIVE_TICK'], -orderInfo['GIVE_REMAINING'], orderInfo['SOURCE']]);
                        credits.push([orderInfo['GIVE_TICK'], orderInfo['GIVE_REMAINING'], orderInfo['SOURCE']]);
                    }

                    // Create record in the orders_statuses table
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'cancelled');
                }

            }

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

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

        // Check to see if we have any matches for this order. Cross-chain orders are NOT
        // matched locally — the counterparty lives in another chain's indexer DB, invisible
        // to the local ORDER_MATCH query. The xchain-hub federation matches them and delivers
        // a validator-signed fill via the hub mirror, which the indexer settles from escrow
        // (see the cross-chain settlement pass). GIVE stays escrowed until filled/cancelled/expired.
        if(status=='valid' && !isCrossChain)
            await this.actions.processAction('ORDER_MATCH', null, data, null);
    }
}

module.exports = Order;
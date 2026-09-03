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
 * XChain Platform Action - CALLBACK
 * 
 * This action performs a callback on a `TICK`. 
 * 
 * PARAMS:
 * - VERSION - Format Version
 * - TICK    - Ticker name or Ticker ID
 * - MEMO    - An optional memo to include
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Callback {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|TICK|MEMO';
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        let callback = Object.assign({}, data);

        let tokenInfo         = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let callbackTokenInfo = (tokenInfo) ? await this.indexerDb.getTokenInfo(tokenInfo['CALLBACK_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']) : null;

        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let holders     = await this.indexerDb.getHolders(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Held as Sets: the holder loop below probes membership once per holder, so an O(1)
        // hash probe replaces a scan of the whole list. Emptiness still gates the check, so a
        // configured-but-empty ALLOW_LIST keeps admitting everyone exactly as before.
        let allowList = (callbackTokenInfo && callbackTokenInfo['ALLOW_LIST']) ? new Set(await this.indexerDb.getList(callbackTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX'])) : new Set();
        let blockList = (callbackTokenInfo && callbackTokenInfo['BLOCK_LIST']) ? new Set(await this.indexerDb.getList(callbackTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX'])) : new Set();

        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // recipients['address'] = amount of CALLBACK_TICK owed to that address
        let recipients = {};

        if(tokenInfo){
            tokenInfo = this.util.setNumberFormats(tokenInfo);
            callback['CALLBACK_TICK']   = tokenInfo['CALLBACK_TICK'];
            callback['CALLBACK_AMOUNT'] = tokenInfo['CALLBACK_AMOUNT'];
        }

        let totalTickAmount         = 0;
        let totalCallbackTickAmount = 0;

        if(tokenInfo){
            for(let address in holders){
                let valid  = true;

                if(address==data['SOURCE'])
                   continue;

                if((allowList.size && !allowList.has(address)) || (blockList.size && blockList.has(address)))
                    valid = false;

                if(valid){
                    // AMOUNT owed = BALANCE * CALLBACK_AMOUNT, rounded to the callback tick's decimals
                    let cbDecimals = callbackTokenInfo ? callbackTokenInfo['DECIMALS'] : 0;
                    let amount = this.util.bcmulfloor(holders[address], tokenInfo['CALLBACK_AMOUNT'], cbDecimals);

                    recipients[address]  = amount;
                    totalCallbackTickAmount = this.util.bcadd(totalCallbackTickAmount, amount, cbDecimals)
                }

                totalTickAmount = this.util.bcadd(totalTickAmount, holders[address], tokenInfo['DECIMALS'])
            }
        }

        // Determine the total transaction FEE. UNIFIED_FEES_SWEEP_CALLBACK gates the move off
        // the legacy per-DB-hit model: the legacy price has no floor, so on LTC/DOGE (where
        // detectFeePaymentMode REJECTS a missing native-coin fee output rather than falling
        // back to an XCHAIN debit) a small CALLBACK priced below the chain's dust threshold
        // and could not be submitted at all. Below the flag-day the legacy model is
        // reproduced exactly so a pre-activation replay commits the identical fee. See
        // protocol_changes.js.
        let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES_SWEEP_CALLBACK', data['BLOCK_INDEX']);
        if(unifiedFees){
            // Unified gas schedule: a flat base plus per-recipient gas, at DIVIDEND/AIRDROP
            // per-recipient parity. `recipients` is the post-ALLOW_LIST/BLOCK_LIST set the
            // settlement block below credits, which is the same count the legacy db_hits term
            // used, so only the price changes.
            let result = this.util.getUnifiedBaseItemFee(Object.keys(recipients).length, 'CALLBACK_BASE', 'CALLBACK_PER_RECIPIENT');
            fees['GAS_COST']    = result.gasCost;
            fees['AMOUNT']      = result.fee;
            fees['FEE_VERSION'] = 2;
        } else {
            // Legacy: database hits model. LEGACY_FEE_NUMERIC_DBHITS gates the db_hits
            // string-concatenation fix: below THAT flag-day reproduce the original
            // `+= bcmul(...)` concatenation byte-for-byte (4 + "6" -> "46") for
            // pre-activation replay parity; at/above it accumulate numerically. See
            // protocol_changes.js.
            let numericDbHits = await this.actions.protocolChanges.isEnabled('LEGACY_FEE_NUMERIC_DBHITS', data['BLOCK_INDEX']);
            let db_hits = 4;                                                                   // 1 debits, 1 credits, 1 balances, 1 callback
            if(numericDbHits)
                db_hits += (recipients) ? Number(Object.keys(recipients).length) * 3 : 0;      // 1 debits, 1 credits, 1 balances
            else
                db_hits += (recipients) ? this.util.bcmul(Object.keys(recipients).length, 3, 0) : 0;
            fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);
        }

        // Emitted (VM-synthesized) actions pay no separate per-tx fee; see util.feeForAction.
        fees['AMOUNT'] = this.util.feeForAction(fees['AMOUNT'], data);

        /*****************************************************************
         * TICK Validations
         ****************************************************************/

        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        if(!error && !callbackTokenInfo)
            error = 'invalid: CALLBACK_TICK (unknown)';

        /*****************************************************************
         * ACTION Validations
         ****************************************************************/

        if(!error && !this.util.isNull(tokenInfo['LOCK_CALLBACK']) && tokenInfo['LOCK_CALLBACK']==1)
            error = "invalid: LOCK_CALLBACK";

        if(!error && data['SOURCE']!=tokenInfo['OWNER'])
            error = "invalid: SOURCE (not authorized)";

        // Reject if TICK ownership is currently escrowed by an open ORDER/SWAP/DISPENSER
        if(!error && await this.indexerDb.isOwnershipEscrowed(data['TICK']))
            error = "invalid: TICK (ownership escrowed)";

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        if(!error && tokenInfo && !this.util.isNull(tokenInfo['CALLBACK_BLOCK']) && tokenInfo['CALLBACK_BLOCK'] != parseInt(tokenInfo['CALLBACK_BLOCK']))
            error = 'invalid: CALLBACK_BLOCK (format)';

        if(!error && tokenInfo && !this.util.isNull(tokenInfo['CALLBACK_AMOUNT']) && !this.util.isValidAmountFormat(callbackTokenInfo['DECIMALS'], tokenInfo['CALLBACK_AMOUNT']))
            error = 'invalid: CALLBACK_AMOUNT (format)';

        /*****************************************************************
         * General Validations
         ****************************************************************/

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        if(!error && await this.indexerDb.isActionAllowed(null, tokenInfo['TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: TICK (sleeping)';

        if(!error && await this.indexerDb.isActionAllowed(null, tokenInfo['CALLBACK_TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: CALLBACK_TICK (sleeping)';

        if(!error && tokenInfo && !this.util.isNull(tokenInfo['CALLBACK_BLOCK']) && tokenInfo['CALLBACK_BLOCK'] > data['BLOCK_INDEX'])
            error = 'invalid: CALLBACK_BLOCK (block index)';

        // MEMO cannot contain '|' (field delimiter) or ';' (action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        if(!error && !this.util.hasBalance(balances, callbackTokenInfo['TICK_ID'], totalCallbackTickAmount))
            error = 'invalid: insufficient funds (CALLBACK_TICK)';

        if(!error)
            balances = this.util.debitBalances(balances, callbackTokenInfo['TICK_ID'], totalCallbackTickAmount);

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

        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        let status = (error) ? error : 'valid';
        data['STATUS'] = callback['STATUS'] = status;

        console.log("\t CALLBACK : " + data['TICK'] + ' : '  +  data['MEMO'] + ' : ' + data['STATUS']);

        await this.indexerDb.createCallback(callback);

        this.util.addAddressTicker(data['SOURCE'], [callback['TICK'], callback['CALLBACK_TICK']]);

        if(status=='valid'){

            let credits = [],
                debits  = [];

            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            for(let address in holders){

                if(address==data['SOURCE'])
                   continue;

                debits.push([callback['TICK'], holders[address], address]);

                this.util.addAddressTicker(address, callback['TICK']);
            }

            credits.push([callback['TICK'], totalTickAmount, callback['SOURCE']]);

            debits.push([callback['CALLBACK_TICK'], totalCallbackTickAmount, callback['SOURCE']]);

            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            for(let address in recipients){

                this.util.addAddressTicker(address, callback['CALLBACK_TICK']);

                credits.push([callback['CALLBACK_TICK'], recipients[address], address]);
            }

            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);
        }

        await this.mapper.createMappings(data);
    }
}

module.exports = Callback;
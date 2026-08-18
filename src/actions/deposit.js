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
 * XChain Platform Action - DEPOSIT
 *
 * This action transfers tokens from a user to a contract's custody.
 * No gas fee; on-chain transaction cost is sufficient.
 *
 * PARAMS:
 * - VERSION              - Format Version
 * - CONTRACT_ACTION_INDEX - Action index of the deployed contract
 * - TICK                 - Ticker name or Ticker ID
 * - QUANTITY             - Amount of tokens to deposit
 *
 * FORMATS:
 * - 0 = Deposit tokens to contract
 *
 ********************************************************************/

class Deposit {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|CONTRACT_ACTION_INDEX|TICK|QUANTITY';
    }

    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        data['CONTRACT_ACTION_INDEX'] = params[1];
        data['TICK']                  = params[2];
        data['AMOUNT']                = params[3];

        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Contract Validations
         ****************************************************************/

        if(!error && this.util.isNull(data['CONTRACT_ACTION_INDEX']))
            error = 'invalid: CONTRACT_ACTION_INDEX (required)';

        // Verify CONTRACT_ACTION_INDEX is a canonical integer index. This must reject at
        // parse, not just null at storage: the SQL existence lookup coerces a numeric-ish
        // string onto a real contract id while the derived custody address keeps the raw
        // form, crediting a phantom address the contract can never spend from. `/^\d+$/`
        // rejected '2.0' but NOT leading-zero forms ('02','007'), which coerce to the real
        // contract id in SQL yet derive 'C:CHAIN:02' - a distinct address_id from the
        // contract's canonical 'C:CHAIN:2' custody, silently stranding the deposit. Require
        // a canonical no-leading-zero integer. Same gate the contract-staking family
        // (STAKE/UNSTAKE/DELEGATE v3) uses - apply the same tightening there.
        if(!error && !/^[1-9]\d*$/.test(String(data['CONTRACT_ACTION_INDEX'])))
            error = 'invalid: CONTRACT_ACTION_INDEX (format)';

        let contractInfo = null;
        if(!error){
            contractInfo = await this.indexerDb.getContract(data['CONTRACT_ACTION_INDEX']);
            if(!contractInfo)
                error = 'invalid: CONTRACT_ACTION_INDEX (unknown)';
        }

        if(!error && contractInfo){
            let contractStatus = await this.indexerDb.getStatusString(contractInfo.status_id);
            if(contractStatus !== 'valid')
                error = 'invalid: contract (not active)';
        }

        /*****************************************************************
         * Token Validations
         ****************************************************************/

        let tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        if(!error && !this.util.isNull(data['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], data['AMOUNT']))
            error = 'invalid: AMOUNT (format)';

        if(!error && !this.util.bcgt(data['AMOUNT'], 0))
            error = 'invalid: AMOUNT (zero)';

        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        if(!error && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], data['AMOUNT']))
            error = 'invalid: insufficient funds (TICK)';

        if(!error)
            balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], data['AMOUNT']);

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        if(!error && await this.indexerDb.isActionAllowed(null, data['TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: TICK (sleeping)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t DEPOSIT : contract=" + data['CONTRACT_ACTION_INDEX'] + ' : ' + data['TICK'] + ' : ' + this.util.logAmount(data['AMOUNT']) + ' : ' + data['STATUS']);

        await this.indexerDb.createDeposit(data);

        let contractAddress = 'C:' + this.config['CHAIN'] + ':' + data['CONTRACT_ACTION_INDEX'];

        this.util.addAddressTicker(data['SOURCE'], data['TICK']);
        if(status === 'valid')
            this.util.addAddressTicker(contractAddress, data['TICK']);

        let credits = [],
            debits  = [];

        // Debit from SOURCE, credit to contract derived address
        if(status === 'valid'){
            debits.push([data['TICK'], data['AMOUNT'], data['SOURCE']]);
            credits.push([data['TICK'], data['AMOUNT'], contractAddress]);
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Deposit;

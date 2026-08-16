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

        if(!error && this.util.isNull(data['CONTRACT_ACTION_INDEX']))
            error = 'invalid: CONTRACT_ACTION_INDEX (required)';

        // Verify CONTRACT_ACTION_INDEX is a canonical integer index (see deposit.js: a
        // coercible non-canonical form - '2.0' or a leading-zero '02'/'007' - would resolve
        // a real contract but derive a phantom custody address string, and non-numeric junk
        // must not reach the row write). Require a no-leading-zero integer, matching deposit.js.
        if(!error && !/^[1-9]\d*$/.test(String(data['CONTRACT_ACTION_INDEX'])))
            error = 'invalid: CONTRACT_ACTION_INDEX (format)';

        let contractInfo = null;
        if(!error){
            contractInfo = await this.indexerDb.getContract(data['CONTRACT_ACTION_INDEX']);
            if(!contractInfo)
                error = 'invalid: CONTRACT_ACTION_INDEX (unknown)';
        }

        if(!error && contractInfo){
            let ownerId = await this.indexerDb.getAddressId(data['SOURCE']);
            if(ownerId === null || Number(ownerId) !== Number(contractInfo.source_id))
                error = 'invalid: SOURCE (not contract owner)';
        }

        let tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        if(!error && !this.util.isNull(data['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], data['AMOUNT']))
            error = 'invalid: AMOUNT (format)';

        if(!error && !this.util.bcgt(data['AMOUNT'], 0))
            error = 'invalid: AMOUNT (zero)';

        let contractAddress = 'C:' + this.config['CHAIN'] + ':' + data['CONTRACT_ACTION_INDEX'];
        if(!error){
            let contractBalances = await this.indexerDb.getAddressBalances(contractAddress, null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(!this.util.hasBalance(contractBalances, tokenInfo['TICK_ID'], data['AMOUNT']))
                error = 'invalid: insufficient contract balance';
        }

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Every other token-moving handler (its mirror DEPOSIT,
        // plus SEND/MINT/AIRDROP/CALLBACK/DESTROY/ORDER/SWAP/DISPENSER) blocks movement of a
        // sleeping tick; WITHDRAW was the sole omission, so a frozen token could be pulled out
        // of contract custody while DEPOSIT of the same tick is rejected.
        if(!error && await this.indexerDb.isActionAllowed(null, data['TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: TICK (sleeping)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t WITHDRAW : contract=" + data['CONTRACT_ACTION_INDEX'] + ' : ' + data['TICK'] + ' : ' + this.util.logAmount(data['AMOUNT']) + ' : ' + data['STATUS']);

        await this.indexerDb.createWithdrawal(data);

        this.util.addAddressTicker(data['SOURCE'], data['TICK']);
        if(status === 'valid')
            this.util.addAddressTicker(contractAddress, data['TICK']);

        let credits = [],
            debits  = [];

        if(status === 'valid'){
            debits.push([data['TICK'], data['AMOUNT'], contractAddress]);
            credits.push([data['TICK'], data['AMOUNT'], data['SOURCE']]);
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Withdraw;

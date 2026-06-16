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
 *  XChain Platform Action - MINT
 * 
 * This action mints `TICK` supply.
 * 
 * PARAMS:
 * - VERSION     - Format Version
 * - TICK        - Ticker name or Ticker ID
 * - AMOUNT      - Amount of tokens to mint
 * - DESTINATION - Address to transfer tokens to
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Mint {

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
        this.formats[0] = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO';
    }

    // Handle parsing the MINT transaction
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

        // Clone the raw data for storage in mints table
        let mint = Object.assign({}, data);

        // Get information on token
        let tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get total token minted from this address
        let minted = await this.indexerDb.getActionCreditDebitAmount('credits', 'MINT', data['TICK'], data['SOURCE'], data['ACTION_INDEX']);

        // Verify TICK is valid before MINT
        if(tokenInfo['BLOCK_INDEX']==data['BLOCK_INDEX'] && !(await this.indexerDb.validTickerBeforeTxIndex(data['TICK'], data['ACTION_INDEX'])))
            tokenInfo = null;

        // Validate TICK exists
        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        // Validate DESTINATION and SOURCE are different
        if(data['DESTINATION'] == data['SOURCE'])
            delete data['DESTINATION'];

        // Update transaction object with basic token details and ensure the values are numbers and not strings
        if(tokenInfo){
            data['SUPPLY']           = (tokenInfo && !this.util.isNull(tokenInfo['SUPPLY']))           ? this.util.bcnum(tokenInfo['SUPPLY']) : 0;
            data['DECIMALS']         = (tokenInfo && !this.util.isNull(tokenInfo['DECIMALS']))         ? this.util.bcnum(tokenInfo['DECIMALS']) : 0;
            data['MAX_SUPPLY']       = (tokenInfo && !this.util.isNull(tokenInfo['MAX_SUPPLY']))       ? this.util.bcnum(tokenInfo['MAX_SUPPLY']) : 0;
            data['MAX_MINT']         = (tokenInfo && !this.util.isNull(tokenInfo['MAX_MINT']))         ? this.util.bcnum(tokenInfo['MAX_MINT']) : 0;
            data['MINT_ADDRESS_MAX'] = (tokenInfo && !this.util.isNull(tokenInfo['MINT_ADDRESS_MAX'])) ? this.util.bcnum(tokenInfo['MINT_ADDRESS_MAX']) : 0;
            data['MINT_START_BLOCK'] = (tokenInfo && !this.util.isNull(tokenInfo['MINT_START_BLOCK'])) ? this.util.bcnum(tokenInfo['MINT_START_BLOCK']) : 0;
            data['MINT_STOP_BLOCK']  = (tokenInfo && !this.util.isNull(tokenInfo['MINT_STOP_BLOCK']))  ? this.util.bcnum(tokenInfo['MINT_STOP_BLOCK']) : 0;
        }

        /*****************************************************************
         * ACTION Validations
         ****************************************************************/

        // Verify MINT is allowed
        if(!error && !this.util.isNull(tokenInfo['LOCK_MINT']) && tokenInfo['LOCK_MINT']==1)
            error = "invalid: LOCK_MINT";

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify AMOUNT format
        if(!error && !this.util.isNull(data['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], data['AMOUNT']))
            error = "invalid: AMOUNT (format)";

        // Verify DESTINATION address format
        if(!error && !this.util.isNull(data['DESTINATION']) && !this.util.isCryptoAddress(data['DESTINATION']))
            error = "invalid: DESTINATION (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(null, data['TICK'], data['BLOCK_INDEX']) == false)
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

        // Verify AMOUNT is less than MAX_MINT (the OPTIONAL per-tx cap). MAX_MINT is
        // stored as 0 when the ISSUE omits it (createToken / db.js), and 0 means
        // "no per-tx cap" — the only supply ceiling is MAX_SUPPLY (MINT.md). Guard the
        // zero case with bcgt(MAX_MINT,0) exactly like the sibling MINT_ADDRESS_MAX /
        // MINT_START_BLOCK / MINT_STOP_BLOCK checks below; without it bcgt(AMOUNT,0) is
        // true for any positive AMOUNT and every mint on a no-MAX_MINT token is rejected.
        if(!error && !this.util.isNull(data['AMOUNT']) && this.util.bcgt(data['MAX_MINT'], 0) && this.util.bcgt(data['AMOUNT'], data['MAX_MINT']))
            error = 'invalid: AMOUNT > MAX_MINT';

        // GAS-tick mint policy: on mainnet, ONLY the GAS address may mint the GAS tick.
        // This is an airtight, consensus-critical backstop that makes an open-mint gas
        // token impossible on mainnet regardless of how the genesis ISSUE was authored
        // (defense-in-depth over LOCK_MINT). On testnet/regtest the GAS tick is left
        // open-mintable so developers can self-mint a little play-money gas (MINT pays
        // no XCHAIN fee, only the native tx fee); the per-mint amount is bounded by the
        // token's own MAX_MINT (set at genesis ISSUE) — no separate cap needed.
        // Subtokens (e.g. XCHAIN.foo) are NOT the GAS tick and are unaffected.
        if(!error && String(data['TICK']).toUpperCase()==this.config['GAS']
           && this.config['NETWORK']!='regtest' && this.config['NETWORK']!='testnet'
           && data['SOURCE']!=this.config['ADDRESS']['GAS'])
            error = 'invalid: GAS Address (mint)';

        // Verify minting AMOUNT will not exceed MAX_SUPPLY
        if(!error && this.util.bcgt(this.util.bcadd(data['SUPPLY'],data['AMOUNT'],data['DECIMALS']), this.util.bcadd(data['MAX_SUPPLY'],0,data['DECIMALS'])))
            error = 'invalid: mint exceeds MAX_SUPPLY';

        // Verify TICK action is allowed from SOURCE (allow/block lists)
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], data['TICK']) == false)
            error = 'invalid: SOURCE (not authorized)';

        // Verify TICK action is allowed to DESTINATION (ALLOW_LIST & BLOCK_LIST)
        if(!error && !this.util.isNull(data['DESTINATION']) && await this.indexerDb.isActionAllowed(data['DESTINATION'], data['TICK']) == false)
            error = 'invalid: DESTINATION (not authorized)';

        // Verify minting AMOUNT will not exceed MINT_ADDRESS_MAX
        if(!error && !this.util.isNull(data['MINT_ADDRESS_MAX']) && this.util.bcgt(data['MINT_ADDRESS_MAX'], 0) && this.util.bcgt(this.util.bcadd(minted, data['AMOUNT'], data['DECIMALS']), data['MINT_ADDRESS_MAX']))
            error = 'invalid: mint exceeds MINT_ADDRESS_MAX';

        // Verify minting begins at MINT_START_BLOCK
        if(!error && !this.util.isNull(data['MINT_START_BLOCK']) && this.util.bcgt(data['MINT_START_BLOCK'], 0) && this.util.bclt(data['BLOCK_INDEX'], data['MINT_START_BLOCK']))
            error = 'invalid: MINT_START_BLOCK';

        // Verify minting ends at MINT_STOP_BLOCK
        if(!error && !this.util.isNull(data['MINT_STOP_BLOCK']) && this.util.bcgt(data['MINT_STOP_BLOCK'], 0) && this.util.bcgt(data['BLOCK_INDEX'], data['MINT_STOP_BLOCK']))
            error = 'invalid: MINT_STOP_BLOCK';

        // Controller-bound token: a `mint`-class controller (or the catch-all `all`) may gate supply
        // creation — deny it or run programmable side-effects — after all MINT validation, before
        // settlement. SOURCE pays the bounded guard gas, billed as a GAS debit in the valid block
        // below (updateTokens there recomputes GAS supply, so the per-block sanityCheck stays balanced).
        let guardFee = 0;
        if(!error && tokenInfo){
            let gasTick     = this.config['GAS'];
            let gasInfo     = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let gasBalances = await this.indexerDb.getAddressBalances(data['SOURCE'], gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                actionType:  'MINT',
                tick:        data['TICK'],
                from:        data['SOURCE'],
                to:          this.util.isNull(data['DESTINATION']) ? data['SOURCE'] : data['DESTINATION'],
                amount:      data['AMOUNT'],
                data:        data,
                gasInfo:     gasInfo,
                gasBalances: gasBalances
            });
            if(result.error)
                error = 'invalid: ' + result.error;
            else
                guardFee = result.guardFee;
        }

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = mint['STATUS'] = status;

        // Print status message 
        console.log("\t MINT : " + data['TICK'] + ' : '  +  data['AMOUNT'] + ' : ' + data['STATUS']);

        // Create record in mints table
        await this.indexerDb.createMint(mint);

        // Store the SOURCE and TICK in addresses list
        this.util.addAddressTicker(data['SOURCE'], data['TICK']);

        // Store the DESTINATION and TICK in addresses list
        if(!this.util.isNull(data['DESTINATION']))
            this.util.addAddressTicker(data['DESTINATION'], data['TICK']);

        // If this was a valid transaction, then mint any actual supply
        if(status=='valid'){

            // Array of credits and debits
            let credits = [],
                debits  = [];

            // Credit MINT_SUPPLY to source address
            if(data['AMOUNT']){
                credits.push([data['TICK'], data['AMOUNT'], data['SOURCE']]);

                // Transfer AMOUNT to DESTINATION address
                if(data['DESTINATION']){
                    debits.push([data['TICK'],  data['AMOUNT'], data['SOURCE']]);
                    credits.push([data['TICK'], data['AMOUNT'], data['DESTINATION']]);
                }
            }

            // Bill the controller-guard gas to SOURCE (GAS burn, no offsetting credit). updateTokens
            // below already recomputes GAS supply so the per-block sanityCheck stays balanced.
            if(this.util.bcgt(guardFee, 0)){
                debits.push([this.config['GAS'], guardFee, data['SOURCE']]);
                this.util.addAddressTicker(data['SOURCE'], this.config['GAS']);
            }

            // Process any transaction ledger changes (credits / debits)
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

            // Get a list of tickers & addresses
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            // Update address balances and token supply
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);
        }

        // Create action mappings
        await this.mapper.createMappings(data);

    }
}

module.exports = Mint;
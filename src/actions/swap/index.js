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

// The handler's parts, in the order parse() calls them. Each takes this handler explicitly
// and reads and updates the parse state it is handed, so the class keeps exactly the
// constructor and parse it has always exported.
const { readParams, loadTokens, detectSides, loadRecords } = require('./context.js');
const { validateTickAndCoin, validateFormats, validateOwnership, validateGeneral,
        validateLists, reserveGiveAmount } = require('./validate.js');
const { priceSwap, validateFeePayment } = require('./fees.js');
const { runListingGuard } = require('./controller_guard.js');
const { recordSwap, settleLedger } = require('./settle.js');

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
        // Example payloads by FORMAT version:
        // let str    = "0|JDOG|1|";
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // VERSION, wire params and the GET_ADDRESS reference, then the tokens, sides and records
        let st = await readParams(this, params, data, error);
        await loadTokens(this, st);
        await detectSides(this, st);
        await loadRecords(this, st);

        /*****************************************************************
         * TICK & COIN Validations
         ****************************************************************/
        validateTickAndCoin(this, st);

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/
        validateFormats(this, st);

        /*****************************************************************
         * Token Ownership Validations (format 0 only)
         ****************************************************************/
        await validateOwnership(this, st);

        /*****************************************************************
         * General Validations
         ****************************************************************/
        await validateGeneral(this, st);
        await validateLists(this, st);
        reserveGiveAmount(this, st);

        // Fee amount, its payment, and the GIVE token's listing guard
        await priceSwap(this, st);
        await validateFeePayment(this, st);
        await runListingGuard(this, st);

        // Status, the action's rows, and the ledger of a valid action
        await recordSwap(this, st);
        await settleLedger(this, st);

        // Create action mappings
        await this.mapper.createMappings(st.data);

        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        // Check to see if we have a match for this swap.
        // Cross-chain swaps are NOT matched locally; the counterparty lives in another
        // chain's indexer DB, invisible to the local SWAP_MATCH query. The xchain-hub
        // federation matches them and delivers a validator-signed match via the hub mirror,
        // which the indexer settles from escrow (see the cross-chain settlement pass).
        if(st.status=='valid' && !st.isCrossChain)
            await this.actions.processAction('SWAP_MATCH', null, st.data, null);
    }
}

module.exports = Swap;
